import type { CacheConfig } from '../../../types';
import { type SqlRow } from '../../../infrastructure/durable/shared';

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
    retention_days: Number(row.retention_days ?? 0),
    upstream_cache_key_names: JSON.parse(
      String(row.upstream_cache_key_names),
    ) as string[],
  };
}
