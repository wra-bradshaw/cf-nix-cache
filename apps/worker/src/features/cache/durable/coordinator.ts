import type {
  AuditEvent,
  CacheConfig,
  CacheReference,
  QuotaReservation,
} from '../../../types';
import type { RpcResult } from '../../../rpc';
import { CoordinatorAudit } from './audit';
import { CoordinatorQuota } from './quota';
import { CoordinatorState } from './state';
import { CoordinatorUploads } from './uploads';
import { RpcOnlyDurableObject } from '../../../infrastructure/durable/shared';

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
CREATE TABLE IF NOT EXISTS audit_outbox (
  event_id TEXT PRIMARY KEY, event TEXT NOT NULL, created_at INTEGER NOT NULL
);`;

export class CacheCoordinator extends RpcOnlyDurableObject {
  private readonly state: CoordinatorState;
  private readonly uploads: CoordinatorUploads;
  private readonly quota: CoordinatorQuota;
  private readonly audit: CoordinatorAudit;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(schema);
    this.state = new CoordinatorState(ctx);
    this.uploads = new CoordinatorUploads(ctx, env);
    this.quota = new CoordinatorQuota(ctx);
    this.audit = new CoordinatorAudit(ctx, env);
  }

  initialize(input: {
    reference: CacheReference;
    public: boolean;
    quota_bytes: number;
    encoding_id: string;
    created_at: number;
  }): Promise<RpcResult<CacheConfig>> {
    return this.state.initialize(input);
  }

  getCache(): Promise<RpcResult<CacheConfig>> {
    return this.state.getCache();
  }

  configure(input: { public: boolean }): Promise<RpcResult<CacheConfig>> {
    return this.state.configure(input);
  }

  activate(): Promise<RpcResult<CacheConfig>> {
    return this.state.activate();
  }

  beginDelete(): Promise<RpcResult<CacheConfig>> {
    return this.state.beginDelete();
  }

  remove(): Promise<RpcResult<void>> {
    return this.state.remove();
  }

  allocateUpload(input: {
    operation_id: string;
    fingerprint: string;
  }): Promise<
    RpcResult<{ id: string; staging_key: string; repeated: boolean }>
  > {
    return this.uploads.allocate(input);
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

  recordAudit(event: AuditEvent): Promise<RpcResult<void>> {
    return this.audit.record(event);
  }

  flushAudit(): Promise<RpcResult<void>> {
    return this.audit.flush();
  }

  alarm(): Promise<void> {
    return this.audit.alarm();
  }
}
