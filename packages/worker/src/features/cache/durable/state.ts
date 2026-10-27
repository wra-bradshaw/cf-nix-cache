import type { CacheConfig, CacheReference } from '../../../types';
import type { RpcResult } from '../../../rpc';
import { toCache } from './helpers';
import {
  failure,
  first,
  ok,
  type SqlRow,
} from '../../../infrastructure/durable/shared';

export class CoordinatorState {
  constructor(private readonly ctx: DurableObjectState) {}

  private row(): SqlRow | undefined {
    return first(
      this.ctx.storage.sql.exec<SqlRow>('SELECT * FROM cache LIMIT 1'),
    );
  }

  async initialize(input: {
    reference: CacheReference;
    public: boolean;
    quota_bytes: number;
    encoding_id: string;
    created_at: number;
  }): Promise<RpcResult<CacheConfig>> {
    return this.ctx.storage.transactionSync(() => {
      const existing = this.row();
      if (existing) {
        if (
          String(existing.cache_id) !== input.reference.id ||
          String(existing.incarnation) !== input.reference.incarnation ||
          Number(existing.quota_bytes) !== input.quota_bytes ||
          Number(existing.public) !== (input.public ? 1 : 0) ||
          String(existing.encoding_id) !== input.encoding_id
        ) {
          return failure(
            'coordinator_conflict',
            'cache coordinator is already assigned to another incarnation',
            409,
          );
        }
        return ok(toCache(existing));
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO cache (cache_id, name, incarnation, public, quota_bytes, encoding_id, created_at, lifecycle) VALUES (?, ?, ?, ?, ?, ?, ?, 'CREATING')",
        input.reference.id,
        input.reference.name,
        input.reference.incarnation,
        input.public ? 1 : 0,
        input.quota_bytes,
        input.encoding_id,
        input.created_at,
      );
      return ok({
        id: input.reference.id,
        name: input.reference.name,
        public: input.public,
        quota_bytes: input.quota_bytes,
        logical_bytes: 0,
        encoding_id: input.encoding_id as CacheConfig['encoding_id'],
        created_at: input.created_at,
        lifecycle: 'CREATING',
      });
    });
  }

  async getCache(): Promise<RpcResult<CacheConfig>> {
    const row = this.row();
    return row
      ? ok(toCache(row))
      : failure('not_found', 'cache not found', 404);
  }

  async configure(input: { public: boolean }): Promise<RpcResult<CacheConfig>> {
    return this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (!row) return failure('not_found', 'cache not found', 404);
      if (String(row.lifecycle) === 'DELETING')
        return failure('cache_deleting', 'cache is being deleted', 410);
      this.ctx.storage.sql.exec(
        'UPDATE cache SET public = ?',
        input.public ? 1 : 0,
      );
      return ok(toCache({ ...row, public: input.public ? 1 : 0 }));
    });
  }

  async activate(): Promise<RpcResult<CacheConfig>> {
    return this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (!row) return failure('not_found', 'cache not found', 404);
      if (String(row.lifecycle) === 'DELETING')
        return failure('cache_deleting', 'cache is being deleted', 410);
      this.ctx.storage.sql.exec(
        "UPDATE cache SET lifecycle = 'ACTIVE' WHERE lifecycle = 'CREATING'",
      );
      return ok(toCache({ ...row, lifecycle: 'ACTIVE' }));
    });
  }

  async beginDelete(): Promise<RpcResult<CacheConfig>> {
    return this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (!row) return failure('not_found', 'cache not found', 404);
      if (String(row.lifecycle) !== 'DELETING')
        this.ctx.storage.sql.exec("UPDATE cache SET lifecycle = 'DELETING'");
      return ok(toCache({ ...row, lifecycle: 'DELETING' }));
    });
  }

  async remove(): Promise<RpcResult<void>> {
    return this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (!row) return ok();
      if (row.lifecycle !== 'DELETING')
        return failure(
          'cache_not_deleting',
          'cache must be deleting before removal',
          409,
        );
      const pendingAudit = first(
        this.ctx.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM audit_outbox',
        ),
      );
      if (pendingAudit && Number(pendingAudit.count) > 0)
        return failure(
          'audit_pending',
          'cache audit events must be delivered before removal',
          503,
        );
      this.ctx.storage.sql.exec(
        'DELETE FROM audit_outbox; DELETE FROM clear_operations; DELETE FROM quota_operations; DELETE FROM upload_allocations; DELETE FROM cache;',
      );
      return ok();
    });
  }
}
