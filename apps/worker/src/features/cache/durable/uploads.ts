import type { RpcResult } from '../../../rpc';
import type { SqlRow } from '../../../infrastructure/durable/shared';
import { failure } from './helpers';

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
      const cache = [
        ...this.ctx.storage.sql.exec<{ lifecycle: string }>(
          'SELECT lifecycle FROM cache LIMIT 1',
        ),
      ][0];
      if (!cache) return failure('not_found', 'cache not found', 404);
      if (cache.lifecycle !== 'ACTIVE')
        return failure(
          cache.lifecycle === 'DELETING'
            ? 'cache_deleting'
            : 'cache_unavailable',
          'cache is not active',
          cache.lifecycle === 'DELETING' ? 410 : 503,
        );
      const old = [
        ...this.ctx.storage.sql.exec<SqlRow>(
          'SELECT fingerprint, upload_id, staging_key FROM upload_allocations WHERE operation_id = ?',
          input.operation_id,
        ),
      ][0];
      if (old) {
        if (String(old.fingerprint) !== input.fingerprint)
          return failure(
            'idempotency_conflict',
            'idempotency key was reused with different upload metadata',
            409,
          );
        return {
          ok: true,
          value: {
            id: String(old.upload_id),
            staging_key: String(old.staging_key),
            repeated: true,
          },
        };
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
      return {
        ok: true,
        value: { id, staging_key: stagingKey, repeated: false },
      };
    });
  }
}
