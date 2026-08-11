import type { CacheConfig } from '../../../types';
import type { RpcResult } from '../../../rpc';
import type { SqlRow } from '../../../infrastructure/durable/shared';

export const failure = (
  code: string,
  message: string,
  status: number,
): RpcResult<never> => ({ ok: false, error: { code, message, status } });

export function toCache(row: SqlRow): CacheConfig {
  return {
    id: String(row.cache_id),
    name: String(row.name),
    public: Number(row.public) === 1,
    quota_bytes: Number(row.quota_bytes),
    logical_bytes: Number(row.logical_bytes),
    encoding_id: String(row.encoding_id) as CacheConfig['encoding_id'],
    created_at: Number(row.created_at),
    lifecycle: String(row.lifecycle) as CacheConfig['lifecycle'],
  };
}
