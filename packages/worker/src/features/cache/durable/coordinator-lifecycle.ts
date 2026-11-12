import { ENCODING_ID, type CacheConfig, type CacheReference } from '../types';
import { type RpcResult, conflict, failure, ok } from '../../../shared/rpc';
import { first, type SqlRow, text, integer, json } from '../../../shared/sql';
import { DEFAULT_MIN_AGE_DAYS } from '../../eviction/policy';
import type { EvictionResult } from '../../eviction/types';

function encodingId(value: string): CacheConfig['encoding_id'] {
  if (value !== ENCODING_ID)
    throw new Error(`cache encoding ${value} is not a known encoding`);
  return value;
}

function publicFlag(value: number): boolean {
  if (value === 1) return true;
  if (value === 0) return false;
  throw new Error(`cache public flag ${value} is not 0 or 1`);
}

function toCache(row: SqlRow): CacheConfig {
  const lifecycle = text(row, 'lifecycle');
  if (
    lifecycle !== 'CREATING' &&
    lifecycle !== 'ACTIVE' &&
    lifecycle !== 'DELETING'
  )
    throw new Error('cache lifecycle is not a known lifecycle');
  return {
    id: text(row, 'cache_id'),
    name: text(row, 'name'),
    public: publicFlag(integer(row, 'public')),
    quota_bytes: integer(row, 'quota_bytes'),
    logical_bytes: integer(row, 'logical_bytes'),
    encoding_id: encodingId(text(row, 'encoding_id')),
    created_at: integer(row, 'created_at'),
    lifecycle,
    retention_days: integer(row, 'retention_days'),
    eviction_min_age_days: integer(row, 'eviction_min_age_days'),
    last_eviction:
      row.last_eviction == null
        ? null
        : json<EvictionResult>(row, 'last_eviction'),
    upstream_cache_key_names: json<string[]>(row, 'upstream_cache_key_names'),
  };
}

function toCacheResult(row: SqlRow): RpcResult<CacheConfig> {
  try {
    return ok(toCache(row));
  } catch {
    return failure('corrupt_cache', 'cache record is corrupt', 500);
  }
}

export class CoordinatorLifecycle {
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
    upstream_cache_key_names: string[];
  }): Promise<RpcResult<CacheConfig>> {
    if (input.encoding_id !== ENCODING_ID)
      return failure(
        'invalid_encoding_id',
        'encoding_id is not a supported encoding',
        400,
      );
    if (
      !Number.isSafeInteger(input.quota_bytes) ||
      input.quota_bytes < 1 ||
      input.quota_bytes > Number.MAX_SAFE_INTEGER
    )
      return failure(
        'invalid_quota',
        'quota_bytes must be an integer between 1 and 9007199254740991',
        400,
      );
    const upstreams = JSON.stringify(input.upstream_cache_key_names);
    return this.ctx.storage.transactionSync(() => {
      const existing = this.row();
      if (existing) {
        try {
          if (
            text(existing, 'cache_id') !== input.reference.id ||
            text(existing, 'incarnation') !== input.reference.incarnation ||
            integer(existing, 'quota_bytes') !== input.quota_bytes ||
            publicFlag(integer(existing, 'public')) !== input.public ||
            text(existing, 'encoding_id') !== input.encoding_id ||
            text(existing, 'upstream_cache_key_names') !== upstreams
          ) {
            return conflict(
              'coordinator_conflict',
              'cache coordinator is already assigned to another incarnation',
            );
          }
        } catch {
          return failure('corrupt_cache', 'cache record is corrupt', 500);
        }
        return toCacheResult(existing);
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO cache (cache_id, name, incarnation, public, quota_bytes, encoding_id, created_at, lifecycle, upstream_cache_key_names) VALUES (?, ?, ?, ?, ?, ?, ?, 'CREATING', ?)",
        input.reference.id,
        input.reference.name,
        input.reference.incarnation,
        input.public ? 1 : 0,
        input.quota_bytes,
        input.encoding_id,
        input.created_at,
        upstreams,
      );
      return ok({
        id: input.reference.id,
        name: input.reference.name,
        public: input.public,
        quota_bytes: input.quota_bytes,
        logical_bytes: 0,
        encoding_id: encodingId(input.encoding_id),
        created_at: input.created_at,
        lifecycle: 'CREATING',
        retention_days: 0,
        eviction_min_age_days: DEFAULT_MIN_AGE_DAYS,
        last_eviction: null,
        upstream_cache_key_names: input.upstream_cache_key_names,
      });
    });
  }

  async getCache(): Promise<RpcResult<CacheConfig>> {
    const row = this.row();
    if (!row) return failure('not_found', 'cache not found', 404);
    return toCacheResult(row);
  }

  async configure(input: {
    public?: boolean;
    retention_days?: number;
    eviction_min_age_days?: number;
    upstream_cache_key_names?: string[];
  }): Promise<RpcResult<CacheConfig>> {
    if (input.public !== undefined && typeof input.public !== 'boolean')
      return failure('invalid_public', 'public must be a boolean', 400);
    if (
      input.retention_days !== undefined &&
      (!Number.isInteger(input.retention_days) ||
        input.retention_days < 0 ||
        input.retention_days > 36500)
    )
      return failure(
        'invalid_retention_days',
        'retention_days must be an integer between 0 and 36500',
        400,
      );
    if (
      input.eviction_min_age_days !== undefined &&
      (!Number.isInteger(input.eviction_min_age_days) ||
        input.eviction_min_age_days < 0 ||
        input.eviction_min_age_days > 36500)
    )
      return failure(
        'invalid_eviction_min_age_days',
        'eviction_min_age_days must be an integer between 0 and 36500',
        400,
      );
    if (input.upstream_cache_key_names !== undefined) {
      const names = input.upstream_cache_key_names;
      if (
        !Array.isArray(names) ||
        names.length > 32 ||
        !names.every(
          (name) =>
            typeof name === 'string' &&
            name.length >= 1 &&
            name.length <= 128 &&
            !/[:\s]/.test(name),
        )
      )
        return failure(
          'invalid_upstream_cache_key_names',
          'upstream_cache_key_names must be an array of up to 32 key names',
          400,
        );
    }
    return this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (!row) return failure('not_found', 'cache not found', 404);
      let next: SqlRow;
      try {
        if (text(row, 'lifecycle') === 'DELETING')
          return failure('cache_deleting', 'cache is being deleted', 410);
        next = {
          ...row,
          public:
            input.public === undefined
              ? publicFlag(integer(row, 'public'))
                ? 1
                : 0
              : input.public === true
                ? 1
                : 0,
          retention_days:
            input.retention_days === undefined
              ? integer(row, 'retention_days')
              : input.retention_days,
          eviction_min_age_days:
            input.eviction_min_age_days === undefined
              ? integer(row, 'eviction_min_age_days')
              : input.eviction_min_age_days,
          upstream_cache_key_names: input.upstream_cache_key_names
            ? JSON.stringify(input.upstream_cache_key_names)
            : text(row, 'upstream_cache_key_names'),
        };
      } catch {
        return failure('corrupt_cache', 'cache record is corrupt', 500);
      }
      this.ctx.storage.sql.exec(
        'UPDATE cache SET public = ?, retention_days = ?, eviction_min_age_days = ?, upstream_cache_key_names = ?',
        next.public,
        next.retention_days,
        next.eviction_min_age_days,
        next.upstream_cache_key_names,
      );
      return toCacheResult(next);
    });
  }

  async activate(): Promise<RpcResult<CacheConfig>> {
    return this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (!row) return failure('not_found', 'cache not found', 404);
      let lifecycle: string;
      try {
        lifecycle = text(row, 'lifecycle');
        if (lifecycle === 'DELETING')
          return failure('cache_deleting', 'cache is being deleted', 410);
        if (lifecycle !== 'CREATING' && lifecycle !== 'ACTIVE')
          return failure('corrupt_cache', 'cache record is corrupt', 500);
      } catch {
        return failure('corrupt_cache', 'cache record is corrupt', 500);
      }
      const changed =
        (
          this.ctx.storage.sql.exec(
            "UPDATE cache SET lifecycle = 'ACTIVE' WHERE lifecycle = 'CREATING'",
          ) as unknown as { rowsWritten?: unknown }
        ).rowsWritten ?? 0;
      if (lifecycle === 'CREATING' && changed === 0)
        return failure('corrupt_cache', 'cache record is corrupt', 500);
      return toCacheResult({ ...row, lifecycle: 'ACTIVE' });
    });
  }

  async beginDelete(): Promise<RpcResult<CacheConfig>> {
    return this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (!row) return failure('not_found', 'cache not found', 404);
      try {
        if (text(row, 'lifecycle') !== 'DELETING')
          this.ctx.storage.sql.exec("UPDATE cache SET lifecycle = 'DELETING'");
      } catch {
        return failure('corrupt_cache', 'cache record is corrupt', 500);
      }
      return toCacheResult({ ...row, lifecycle: 'DELETING' });
    });
  }

  async remove(): Promise<RpcResult<void>> {
    return this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (!row) return ok();
      try {
        if (text(row, 'lifecycle') !== 'DELETING')
          return failure(
            'cache_not_deleting',
            'cache must be deleting before removal',
            409,
          );
        const pendingAudit = first(
          this.ctx.storage.sql.exec<SqlRow>(
            'SELECT COUNT(*) AS count FROM audit_outbox',
          ),
        );
        if (!pendingAudit)
          return failure('corrupt_cache', 'cache record is corrupt', 500);
        if (integer(pendingAudit, 'count') > 0)
          return failure(
            'audit_pending',
            'cache audit events must be delivered before removal',
            503,
          );
      } catch {
        return failure('corrupt_cache', 'cache record is corrupt', 500);
      }
      this.ctx.storage.sql.exec('DELETE FROM audit_outbox');
      this.ctx.storage.sql.exec('DELETE FROM shard_usage');
      this.ctx.storage.sql.exec('DELETE FROM upload_allocations');
      this.ctx.storage.sql.exec('DELETE FROM inflight_uploads');
      this.ctx.storage.sql.exec('DELETE FROM cache');
      return ok();
    });
  }
}
