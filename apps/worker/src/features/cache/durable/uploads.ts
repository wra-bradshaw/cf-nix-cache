import type { RpcResult } from '../../../rpc';
import {
  failure,
  first,
  ok,
  type SqlRow,
} from '../../../infrastructure/durable/shared';

export class CoordinatorUploads {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async allocate(input: {
    operation_id: string;
    fingerprint: string;
  }): Promise<
    RpcResult<{ id: string; staging_key: string; repeated: boolean }>
  > {
    return this.ctx.storage.transactionSync(() => {
      const cache = first(
        this.ctx.storage.sql.exec<{ lifecycle: string }>(
          'SELECT lifecycle FROM cache LIMIT 1',
        ),
      );
      if (!cache) return failure('not_found', 'cache not found', 404);
      if (cache.lifecycle !== 'ACTIVE')
        return failure(
          cache.lifecycle === 'DELETING'
            ? 'cache_deleting'
            : 'cache_unavailable',
          'cache is not active',
          cache.lifecycle === 'DELETING' ? 410 : 503,
        );
      const old = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT fingerprint, upload_id, staging_key FROM upload_allocations WHERE operation_id = ?',
          input.operation_id,
        ),
      );
      if (old) {
        if (String(old.fingerprint) !== input.fingerprint)
          return failure(
            'idempotency_conflict',
            'idempotency key was reused with different upload metadata',
            409,
          );
        return ok({
          id: String(old.upload_id),
          staging_key: String(old.staging_key),
          repeated: true,
        });
      }
      const id = this.env.UPLOAD_JOB!.newUniqueId().toString();
      const stagingKey = `staging/${id}.nar.zst`;
      this.ctx.storage.sql.exec(
        'INSERT INTO upload_allocations (operation_id, fingerprint, upload_id, staging_key) VALUES (?, ?, ?, ?)',
        input.operation_id,
        input.fingerprint,
        id,
        stagingKey,
      );
      return ok({ id, staging_key: stagingKey, repeated: false });
    });
  }
}
