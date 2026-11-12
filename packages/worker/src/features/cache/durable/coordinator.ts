import type { AuditEvent } from '../../audit/types';
import type { CacheConfig, CacheReference, QuotaReservation } from '../types';
import { type RpcResult, failure, ok } from '../../../shared/rpc';
import { AUDIT_OUTBOX_SCHEMA, AuditOutbox } from '../../audit/outbox';
import { CoordinatorQuota, QUOTA_RESERVED_INDEX } from './quota';
import { CoordinatorEviction } from './coordinator-eviction';
import type { EvictionResult } from '../../eviction/types';
import { DEFAULT_MIN_AGE_DAYS } from '../../eviction/policy';
import { CoordinatorLifecycle } from './coordinator-lifecycle';
import {
  type Allocation,
  type AllocationRequest,
  INFLIGHT_SCHEMA,
  UploadAllocations,
} from './upload-allocations';
import { RpcOnlyDurableObject } from '../../../shared/rpc-only-durable-object';

const schema = `CREATE TABLE IF NOT EXISTS cache (
  cache_id TEXT PRIMARY KEY, name TEXT NOT NULL, incarnation TEXT NOT NULL,
  public INTEGER NOT NULL, quota_bytes INTEGER NOT NULL, logical_bytes INTEGER NOT NULL DEFAULT 0,
  encoding_id TEXT NOT NULL, created_at INTEGER NOT NULL, lifecycle TEXT NOT NULL,
  retention_days INTEGER NOT NULL DEFAULT 0, upstream_cache_key_names TEXT NOT NULL,
  eviction_min_age_days INTEGER NOT NULL DEFAULT ${DEFAULT_MIN_AGE_DAYS},
  eviction_generation INTEGER NOT NULL DEFAULT 0, eviction_pending INTEGER NOT NULL DEFAULT 0,
  eviction_requested_at INTEGER NOT NULL DEFAULT 0, last_eviction TEXT
);
CREATE TABLE IF NOT EXISTS quota_operations (
  operation_id TEXT PRIMARY KEY, delta INTEGER NOT NULL, status TEXT NOT NULL
);
${QUOTA_RESERVED_INDEX}
CREATE TABLE IF NOT EXISTS upload_allocations (
  operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, upload_id TEXT NOT NULL UNIQUE, staging_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS clear_operations (
  operation_id TEXT PRIMARY KEY, delta INTEGER NOT NULL
);
${INFLIGHT_SCHEMA}
${AUDIT_OUTBOX_SCHEMA}`;

export class CacheCoordinator extends RpcOnlyDurableObject {
  private readonly lifecycle: CoordinatorLifecycle;
  private readonly allocations: UploadAllocations;
  private readonly quota: CoordinatorQuota;
  private readonly eviction: CoordinatorEviction;
  private readonly audit: AuditOutbox;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(schema);
    this.lifecycle = new CoordinatorLifecycle(ctx);
    this.allocations = new UploadAllocations(ctx, env);
    this.eviction = new CoordinatorEviction(ctx, env);
    this.quota = new CoordinatorQuota(ctx, this.eviction);
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

  async configure(input: {
    public?: boolean;
    retention_days?: number;
    eviction_min_age_days?: number;
    upstream_cache_key_names?: string[];
  }): Promise<RpcResult<CacheConfig>> {
    const result = await this.lifecycle.configure(input);
    // Turning eviction on for a cache already over its watermark.
    if (result.ok) await this.eviction.afterGrowth();
    return result;
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

  settledOperations(input: {
    operation_ids: string[];
  }): Promise<RpcResult<string[]>> {
    return this.quota.settledOperations(input);
  }

  forgetOperations(input: {
    operation_ids: string[];
  }): Promise<RpcResult<void>> {
    return this.quota.forgetOperations(input);
  }

  staleUploads(input: {
    before: number;
    after: string | null;
    limit: number;
  }): Promise<RpcResult<{ upload_ids: string[]; next_after: string | null }>> {
    return this.allocations.stale(input);
  }

  forgetUploads(input: { upload_ids: string[] }): Promise<RpcResult<void>> {
    return this.allocations.forget(input);
  }

  requestEviction(): Promise<RpcResult<{ requested: boolean }>> {
    return this.eviction.requestEviction();
  }

  evictionFinished(input: {
    generation: number;
    result: EvictionResult;
  }): Promise<RpcResult<void>> {
    return this.eviction.finished(input);
  }

  async recordAudit(event: AuditEvent): Promise<RpcResult<void>> {
    this.audit.enqueue(event);
    return ok();
  }

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

  async alarm(): Promise<void> {
    await this.eviction.alarm();
    await this.audit.alarm();
  }
}
