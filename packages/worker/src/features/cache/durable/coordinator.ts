import type { AuditEvent } from '../../audit/types';
import {
  type CacheConfig,
  type CacheReference,
  type QuotaReservation,
  DEFAULT_UPSTREAM_CACHE_KEY_NAMES,
} from '../types';
import { type RpcResult, failure, ok } from '../../../shared/rpc';
import { AUDIT_OUTBOX_SCHEMA, AuditOutbox } from '../../audit/outbox';
import { CoordinatorQuota } from './quota';
import { CoordinatorLifecycle } from './coordinator-lifecycle';
import {
  type Allocation,
  type AllocationRequest,
  INFLIGHT_SCHEMA,
  UploadAllocations,
} from './upload-allocations';
import { RpcOnlyDurableObject } from '../../../shared/rpc-only-durable-object';
import { type SqlRow, text } from '../../../shared/sql';

const schema = `CREATE TABLE IF NOT EXISTS cache (
  cache_id TEXT PRIMARY KEY, name TEXT NOT NULL, incarnation TEXT NOT NULL,
  public INTEGER NOT NULL, quota_bytes INTEGER NOT NULL, logical_bytes INTEGER NOT NULL DEFAULT 0,
  encoding_id TEXT NOT NULL, created_at INTEGER NOT NULL, lifecycle TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quota_operations (
  operation_id TEXT PRIMARY KEY, delta INTEGER NOT NULL, status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS upload_allocations (
  operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, upload_id TEXT NOT NULL UNIQUE, staging_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clear_operations (
  operation_id TEXT PRIMARY KEY, delta INTEGER NOT NULL
);
${INFLIGHT_SCHEMA}
${AUDIT_OUTBOX_SCHEMA}`;

const ADDED_COLUMNS: Record<string, string> = {
  retention_days: 'INTEGER NOT NULL DEFAULT 0',
  upstream_cache_key_names: `TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_UPSTREAM_CACHE_KEY_NAMES)}'`,
};

function addMissingColumns(ctx: DurableObjectState): void {
  let present: Set<string>;
  try {
    present = new Set(
      [...ctx.storage.sql.exec<SqlRow>('PRAGMA table_info(cache)')].map(
        (column) => text(column, 'name'),
      ),
    );
  } catch (error) {
    throw new Error('corrupt_cache: cache schema record is corrupt', {
      cause: error,
    });
  }
  for (const [name, definition] of Object.entries(ADDED_COLUMNS))
    if (!present.has(name))
      ctx.storage.sql.exec(
        `ALTER TABLE cache ADD COLUMN ${name} ${definition}`,
      );
}

export class CacheCoordinator extends RpcOnlyDurableObject {
  private readonly lifecycle: CoordinatorLifecycle;
  private readonly allocations: UploadAllocations;
  private readonly quota: CoordinatorQuota;
  private readonly audit: AuditOutbox;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(schema);
    addMissingColumns(ctx);
    this.lifecycle = new CoordinatorLifecycle(ctx);
    this.allocations = new UploadAllocations(ctx, env);
    this.quota = new CoordinatorQuota(ctx);
    this.audit = new AuditOutbox(ctx, env);
  }

  initialize(input: {
    reference: CacheReference;
    public: boolean;
    quota_bytes: number;
    encoding_id: string;
    created_at: number;
    upstream_cache_key_names: string[];
  }): Promise<RpcResult<CacheConfig>> {
    return this.lifecycle.initialize(input);
  }

  getCache(): Promise<RpcResult<CacheConfig>> {
    return this.lifecycle.getCache();
  }

  configure(input: {
    public?: boolean;
    retention_days?: number;
    upstream_cache_key_names?: string[];
  }): Promise<RpcResult<CacheConfig>> {
    return this.lifecycle.configure(input);
  }

  activate(): Promise<RpcResult<CacheConfig>> {
    return this.lifecycle.activate();
  }

  beginDelete(): Promise<RpcResult<CacheConfig>> {
    return this.lifecycle.beginDelete();
  }

  remove(): Promise<RpcResult<void>> {
    return this.lifecycle.remove();
  }

  allocateUpload(input: AllocationRequest): Promise<RpcResult<Allocation>> {
    return this.allocations.allocate(input);
  }

  pendingUploads(input: {
    store_hashes: string[];
    now: number;
  }): Promise<RpcResult<{ store_hash: string; upload_id: string }[]>> {
    return this.allocations.pending(input);
  }

  releaseUpload(input: {
    store_hash: string;
    upload_id: string;
  }): Promise<RpcResult<void>> {
    return this.allocations.release(input);
  }

  /** An early, non-binding quota check; publication reserves for real. */
  checkQuota(input: { delta: number }): Promise<RpcResult<void>> {
    return this.quota.check(input);
  }

  reserve(input: {
    operation_id: string;
    delta: number;
  }): Promise<RpcResult<QuotaReservation>> {
    return this.quota.reserve(input);
  }

  finalize(input: { operation_id: string }): Promise<RpcResult<void>> {
    return this.quota.finalize(input);
  }

  abort(input: { operation_id: string }): Promise<RpcResult<void>> {
    return this.quota.abort(input);
  }

  reconcile(input: { operation_ids: string[] }): Promise<RpcResult<void>> {
    return this.quota.reconcile(input);
  }

  clearDelta(input: {
    operation_id: string;
    delta: number;
  }): Promise<RpcResult<void>> {
    return this.quota.clearDelta(input);
  }

  async recordAudit(event: AuditEvent): Promise<RpcResult<void>> {
    this.audit.enqueue(event);
    return ok();
  }

  /** Delivers every pending audit event; cache removal waits on this. */
  async flushAudit(): Promise<RpcResult<void>> {
    for (;;) {
      let depth: number;
      try {
        depth = this.audit.pending();
      } catch {
        return failure(
          'audit_unavailable',
          'audit log is unavailable; retry before removing the cache',
          503,
        );
      }
      if (depth <= 0) return ok();
      let drained: boolean;
      try {
        drained = await this.audit.drain();
      } catch {
        // drain's SELECT, DELETE, or alarm scheduling threw (storage error
        // or poison-pill cleanup failure): fail closed so removal retries
        // rather than trusting an unknown backlog as drained.
        return failure(
          'audit_unavailable',
          'audit log is unavailable; retry before removing the cache',
          503,
        );
      }
      if (!drained)
        return failure(
          'audit_unavailable',
          'audit log is unavailable; retry before removing the cache',
          503,
        );
    }
  }

  alarm(): Promise<void> {
    return this.audit.alarm();
  }
}
