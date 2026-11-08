import { ENCODING_ID, type CacheConfig, type CacheReference } from '../types';
import { type RpcResult, conflict, failure, ok } from '../../../shared/rpc';
import {
  first,
  type SqlRow,
  text,
  integer,
  pageCursor,
} from '../../../shared/sql';
import { now } from '../../../shared/clock';
import { RpcOnlyDurableObject } from '../../../shared/rpc-only-durable-object';

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

export class SystemControl extends RpcOnlyDurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS caches (
      cache_id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, incarnation TEXT UNIQUE NOT NULL,
      coordinator_id TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, lifecycle TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS create_operations (
      operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, cache_id TEXT NOT NULL,
      FOREIGN KEY (cache_id) REFERENCES caches(cache_id)
    );
    CREATE TABLE IF NOT EXISTS cache_creation_config (
      cache_id TEXT PRIMARY KEY, public INTEGER NOT NULL,
      quota_bytes INTEGER NOT NULL, encoding_id TEXT NOT NULL,
      FOREIGN KEY (cache_id) REFERENCES caches(cache_id)
    );
    CREATE TABLE IF NOT EXISTS delete_operations (
      cache_id TEXT PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL,
      FOREIGN KEY (cache_id) REFERENCES caches(cache_id)
    );`);
  }

  async createCache(input: {
    operation_id: string;
    fingerprint: string;
    name: string;
    public: boolean;
    quota_bytes: number;
    encoding_id: string;
  }): Promise<RpcResult<{ reference: CacheReference; repeated: boolean }>> {
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
    return this.ctx.storage.transactionSync(() => {
      const oldOperation = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT fingerprint, cache_id FROM create_operations WHERE operation_id = ?',
          input.operation_id,
        ),
      );
      if (oldOperation) {
        let fingerprint: string;
        let cacheId: string;
        try {
          fingerprint = text(oldOperation, 'fingerprint');
          cacheId = text(oldOperation, 'cache_id');
        } catch {
          return failure(
            'corrupt_catalog',
            'cache catalog record is corrupt',
            500,
          );
        }
        if (fingerprint !== input.fingerprint)
          return conflict(
            'idempotency_conflict',
            'idempotency key was reused with different cache configuration',
          );
        const row = first(
          this.ctx.storage.sql.exec<SqlRow>(
            'SELECT cache_id, name, incarnation, coordinator_id, lifecycle FROM caches WHERE cache_id = ?',
            cacheId,
          ),
        );
        if (!row)
          return failure(
            'corrupt_catalog',
            'cache catalog record is corrupt',
            500,
          );
        try {
          return ok({ reference: reference(row), repeated: true });
        } catch {
          return failure(
            'corrupt_catalog',
            'cache catalog record is corrupt',
            500,
          );
        }
      }
      const existing = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT cache_id, name, incarnation, coordinator_id, lifecycle FROM caches WHERE name = ?',
          input.name,
        ),
      );
      if (existing) {
        let lifecycle: string;
        let existingId: string;
        try {
          lifecycle = text(existing, 'lifecycle');
          existingId = text(existing, 'cache_id');
        } catch {
          return failure(
            'corrupt_catalog',
            'cache catalog record is corrupt',
            500,
          );
        }
        if (lifecycle === 'CREATING') {
          const config = first(
            this.ctx.storage.sql.exec<SqlRow>(
              'SELECT public, quota_bytes, encoding_id FROM cache_creation_config WHERE cache_id = ?',
              existingId,
            ),
          );
          try {
            if (!config)
              return failure(
                'corrupt_catalog',
                'cache catalog record is corrupt',
                500,
              );
            if (
              publicFlag(integer(config, 'public')) !== input.public ||
              integer(config, 'quota_bytes') !== input.quota_bytes ||
              text(config, 'encoding_id') !== input.encoding_id
            )
              return failure(
                'cache_creation_conflict',
                'cache creation is already in progress with different configuration',
                409,
              );
            return ok({ reference: reference(existing), repeated: true });
          } catch {
            return failure(
              'corrupt_catalog',
              'cache catalog record is corrupt',
              500,
            );
          }
        }
        if (
          lifecycle !== 'CREATING' &&
          lifecycle !== 'ACTIVE' &&
          lifecycle !== 'DELETING'
        )
          return failure(
            'corrupt_catalog',
            'cache catalog record is corrupt',
            500,
          );
        return failure('cache_exists', 'cache name is already registered', 409);
      }
      const value: CacheReference = {
        id: crypto.randomUUID(),
        name: input.name,
        incarnation: crypto.randomUUID(),
        coordinator_id: this.env.CACHE_COORDINATOR!.newUniqueId().toString(),
        lifecycle: 'CREATING',
      };
      this.ctx.storage.sql.exec(
        "INSERT INTO caches (cache_id, name, incarnation, coordinator_id, created_at, lifecycle) VALUES (?, ?, ?, ?, ?, 'CREATING')",
        value.id,
        value.name,
        value.incarnation,
        value.coordinator_id,
        now(),
      );
      this.ctx.storage.sql.exec(
        'INSERT INTO create_operations (operation_id, fingerprint, cache_id) VALUES (?, ?, ?)',
        input.operation_id,
        input.fingerprint,
        value.id,
      );
      this.ctx.storage.sql.exec(
        'INSERT INTO cache_creation_config (cache_id, public, quota_bytes, encoding_id) VALUES (?, ?, ?, ?)',
        value.id,
        input.public ? 1 : 0,
        input.quota_bytes,
        input.encoding_id,
      );
      return ok({ reference: value, repeated: false });
    });
  }

  async getCache(name: string): Promise<RpcResult<CacheReference>> {
    const row = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT cache_id, name, incarnation, coordinator_id, lifecycle FROM caches WHERE name = ?',
        name,
      ),
    );
    if (!row) return failure('not_found', 'cache not found', 404);
    try {
      return ok(reference(row));
    } catch {
      return failure('corrupt_catalog', 'cache catalog record is corrupt', 500);
    }
  }

  async catalogueConfig(
    value: CacheReference,
  ): Promise<RpcResult<CacheConfig>> {
    const row = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT c.name, c.created_at, c.lifecycle, f.public, f.quota_bytes, f.encoding_id FROM caches c JOIN cache_creation_config f ON f.cache_id = c.cache_id WHERE c.cache_id = ? AND c.incarnation = ?',
        value.id,
        value.incarnation,
      ),
    );
    if (!row) return failure('not_found', 'cache not found', 404);
    try {
      const lifecycle = text(row, 'lifecycle');
      if (
        lifecycle !== 'CREATING' &&
        lifecycle !== 'ACTIVE' &&
        lifecycle !== 'DELETING'
      )
        throw new Error('catalog lifecycle is not a known lifecycle');
      return ok({
        id: value.id,
        name: text(row, 'name'),
        public: publicFlag(integer(row, 'public')),
        quota_bytes: integer(row, 'quota_bytes'),
        logical_bytes: 0,
        encoding_id: encodingId(text(row, 'encoding_id')),
        created_at: integer(row, 'created_at'),
        lifecycle: lifecycle as CacheConfig['lifecycle'],
        retention_days: 0,
        upstream_cache_key_names: [],
      });
    } catch {
      return failure('corrupt_catalog', 'cache catalog record is corrupt', 500);
    }
  }

  async activateCache(value: CacheReference): Promise<RpcResult<void>> {
    const result = this.ctx.storage.transactionSync(() => {
      const changed =
        (this.ctx.storage.sql.exec(
          "UPDATE caches SET lifecycle = 'ACTIVE' WHERE cache_id = ? AND incarnation = ? AND lifecycle = 'CREATING'",
          value.id,
          value.incarnation,
        ) as unknown as { rowsWritten?: unknown }).rowsWritten ?? 0;
      const row = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT lifecycle FROM caches WHERE cache_id = ? AND incarnation = ?',
          value.id,
          value.incarnation,
        ),
      );
      if (!row) return failure('not_found', 'cache not found', 404);
      try {
        if (text(row, 'lifecycle') !== 'ACTIVE' && changed === 0)
          return failure('cache_deleting', 'cache is being deleted', 410);
      } catch {
        return failure(
          'corrupt_catalog',
          'cache catalog record is corrupt',
          500,
        );
      }
      return ok();
    });
    return result;
  }

  async beginDelete(input: {
    reference: CacheReference;
    operation_id: string;
  }): Promise<RpcResult<{ operation_id: string; repeated: boolean }>> {
    return this.ctx.storage.transactionSync(() => {
      const row = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT lifecycle FROM caches WHERE cache_id = ? AND incarnation = ?',
          input.reference.id,
          input.reference.incarnation,
        ),
      );
      if (!row) return failure('not_found', 'cache not found', 404);
      const operationOnCache = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT cache_id FROM delete_operations WHERE operation_id = ?',
          input.operation_id,
        ),
      );
      try {
        if (
          operationOnCache &&
          text(operationOnCache, 'cache_id') !== input.reference.id
        )
          return conflict(
            'idempotency_conflict',
            'idempotency key is already assigned to another cache deletion',
          );
      } catch {
        return failure(
          'corrupt_catalog',
          'cache catalog record is corrupt',
          500,
        );
      }
      const existing = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT operation_id FROM delete_operations WHERE cache_id = ?',
          input.reference.id,
        ),
      );
      if (existing)
        try {
          return ok({
            operation_id: text(existing, 'operation_id'),
            repeated: true,
          });
        } catch {
          return failure(
            'corrupt_catalog',
            'cache catalog record is corrupt',
            500,
          );
        }
      this.ctx.storage.sql.exec(
        "UPDATE caches SET lifecycle = 'DELETING' WHERE cache_id = ? AND incarnation = ?",
        input.reference.id,
        input.reference.incarnation,
      );
      this.ctx.storage.sql.exec(
        'INSERT INTO delete_operations (cache_id, operation_id) VALUES (?, ?)',
        input.reference.id,
        input.operation_id,
      );
      return ok({ operation_id: input.operation_id, repeated: false });
    });
  }

  async removeCache(value: CacheReference): Promise<RpcResult<void>> {
    return this.ctx.storage.transactionSync(() => {
      const row = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT lifecycle FROM caches WHERE cache_id = ? AND incarnation = ?',
          value.id,
          value.incarnation,
        ),
      );
      if (!row) return ok();
      try {
        if (text(row, 'lifecycle') !== 'DELETING')
          return failure(
            'cache_not_deleting',
            'cache must be deleting before removal',
            409,
          );
      } catch {
        return failure(
          'corrupt_catalog',
          'cache catalog record is corrupt',
          500,
        );
      }
      this.ctx.storage.sql.exec(
        'DELETE FROM create_operations WHERE cache_id = ?',
        value.id,
      );
      this.ctx.storage.sql.exec(
        'DELETE FROM delete_operations WHERE cache_id = ?',
        value.id,
      );
      this.ctx.storage.sql.exec(
        'DELETE FROM cache_creation_config WHERE cache_id = ?',
        value.id,
      );
      this.ctx.storage.sql.exec(
        'DELETE FROM caches WHERE cache_id = ? AND incarnation = ?',
        value.id,
        value.incarnation,
      );
      return ok();
    });
  }

  async listCaches(input: {
    after: string | null;
    limit: number;
  }): Promise<
    RpcResult<{ items: CacheReference[]; next_after: string | null }>
  > {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      return failure('invalid_limit', 'limit must be between 1 and 100', 400);
    if (input.after !== null && typeof input.after !== 'string')
      return failure('invalid_after', 'after must be a string or null', 400);
    const limit = input.limit;
    const rows = [
      ...this.ctx.storage.sql.exec<SqlRow>(
        input.after !== null
          ? 'SELECT cache_id, name, incarnation, coordinator_id, lifecycle FROM caches WHERE name > ? ORDER BY name LIMIT ?'
          : 'SELECT cache_id, name, incarnation, coordinator_id, lifecycle FROM caches ORDER BY name LIMIT ?',
        ...(input.after !== null ? [input.after, limit + 1] : [limit + 1]),
      ),
    ];
    try {
      return ok({
        items: rows.slice(0, limit).map(reference),
        next_after: pageCursor(rows, limit, (row) => text(row, 'name')),
      });
    } catch {
      return failure('corrupt_catalog', 'cache catalog record is corrupt', 500);
    }
  }
}

function reference(row: SqlRow): CacheReference {
  const lifecycle = text(row, 'lifecycle');
  if (
    lifecycle !== 'CREATING' &&
    lifecycle !== 'ACTIVE' &&
    lifecycle !== 'DELETING'
  )
    throw new Error('catalog lifecycle is not a known lifecycle');
  return {
    id: text(row, 'cache_id'),
    name: text(row, 'name'),
    incarnation: text(row, 'incarnation'),
    coordinator_id: text(row, 'coordinator_id'),
    lifecycle,
  };
}
