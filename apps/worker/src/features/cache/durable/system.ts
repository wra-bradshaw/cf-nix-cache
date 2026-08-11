import { DurableObject } from 'cloudflare:workers';
import type { CacheReference } from '../../../types';
import type { RpcResult } from '../../../rpc';
import {
  initialize,
  now,
  type SqlRow,
} from '../../../infrastructure/durable/shared';

const failure = (
  code: string,
  message: string,
  status: number,
): RpcResult<never> => ({ ok: false, error: { code, message, status } });

export class SystemControl extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initialize(
      ctx,
      `CREATE TABLE IF NOT EXISTS caches (
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
    );`,
    );
  }

  async createCache(input: {
    operation_id: string;
    fingerprint: string;
    name: string;
    public: boolean;
    quota_bytes: number;
    encoding_id: string;
  }): Promise<RpcResult<{ reference: CacheReference; repeated: boolean }>> {
    return this.ctx.storage.transactionSync(() => {
      const oldOperation = [
        ...this.ctx.storage.sql.exec<SqlRow>(
          'SELECT fingerprint, cache_id FROM create_operations WHERE operation_id = ?',
          input.operation_id,
        ),
      ][0];
      if (oldOperation) {
        if (String(oldOperation.fingerprint) !== input.fingerprint)
          return failure(
            'idempotency_conflict',
            'idempotency key was reused with different cache configuration',
            409,
          );
        const row = [
          ...this.ctx.storage.sql.exec<SqlRow>(
            'SELECT cache_id, name, incarnation, coordinator_id FROM caches WHERE cache_id = ?',
            oldOperation.cache_id,
          ),
        ][0];
        return row
          ? { ok: true, value: { reference: reference(row), repeated: true } }
          : failure(
              'operation_not_found',
              'cache creation record is missing',
              503,
            );
      }
      const existing = [
        ...this.ctx.storage.sql.exec<SqlRow>(
          'SELECT cache_id, name, incarnation, coordinator_id, lifecycle FROM caches WHERE name = ?',
          input.name,
        ),
      ][0];
      if (existing) {
        // A request can be lost after the catalogue row is committed but
        // before the coordinator is initialized/activated. Treat a new
        // request for the same name as a recovery attempt, while fencing it
        // to the original creation configuration.
        if (String(existing.lifecycle) === 'CREATING') {
          const config = [
            ...this.ctx.storage.sql.exec<SqlRow>(
              'SELECT public, quota_bytes, encoding_id FROM cache_creation_config WHERE cache_id = ?',
              existing.cache_id,
            ),
          ][0];
          if (
            config &&
            (Number(config.public) !== (input.public ? 1 : 0) ||
              Number(config.quota_bytes) !== input.quota_bytes ||
              String(config.encoding_id) !== input.encoding_id)
          )
            return failure(
              'cache_creation_conflict',
              'cache creation is already in progress with different configuration',
              409,
            );
          return {
            ok: true,
            value: { reference: reference(existing), repeated: true },
          };
        }
        return failure('cache_exists', 'cache name is already registered', 409);
      }
      const value: CacheReference = {
        id: crypto.randomUUID(),
        name: input.name,
        incarnation: crypto.randomUUID(),
        coordinator_id: this.env.CACHE_COORDINATOR!.newUniqueId().toString(),
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
      return { ok: true, value: { reference: value, repeated: false } };
    });
  }

  async getCache(name: string): Promise<RpcResult<CacheReference>> {
    const row = [
      ...this.ctx.storage.sql.exec<SqlRow>(
        'SELECT cache_id, name, incarnation, coordinator_id, lifecycle FROM caches WHERE name = ?',
        name,
      ),
    ][0];
    return row
      ? { ok: true, value: reference(row) }
      : failure('not_found', 'cache not found', 404);
  }

  async activateCache(value: CacheReference): Promise<RpcResult<void>> {
    const result = this.ctx.storage.transactionSync(() => {
      const changed = this.ctx.storage.sql.exec(
        "UPDATE caches SET lifecycle = 'ACTIVE' WHERE cache_id = ? AND incarnation = ? AND lifecycle = 'CREATING'",
        value.id,
        value.incarnation,
      ).rowsWritten;
      const row = [
        ...this.ctx.storage.sql.exec<{ lifecycle: string }>(
          'SELECT lifecycle FROM caches WHERE cache_id = ? AND incarnation = ?',
          value.id,
          value.incarnation,
        ),
      ][0];
      if (!row) return failure('not_found', 'cache not found', 404);
      if (row.lifecycle !== 'ACTIVE' && changed === 0)
        return failure(
          'cache_unavailable',
          'cache could not be activated',
          503,
        );
      return { ok: true as const, value: undefined };
    });
    return result;
  }

  async beginDelete(input: {
    reference: CacheReference;
    operation_id: string;
  }): Promise<RpcResult<{ operation_id: string; repeated: boolean }>> {
    return this.ctx.storage.transactionSync(() => {
      const row = [
        ...this.ctx.storage.sql.exec<{ lifecycle: string }>(
          'SELECT lifecycle FROM caches WHERE cache_id = ? AND incarnation = ?',
          input.reference.id,
          input.reference.incarnation,
        ),
      ][0];
      if (!row) return failure('not_found', 'cache not found', 404);
      const operationOnCache = [
        ...this.ctx.storage.sql.exec<{ cache_id: string }>(
          'SELECT cache_id FROM delete_operations WHERE operation_id = ?',
          input.operation_id,
        ),
      ][0];
      if (
        operationOnCache &&
        String(operationOnCache.cache_id) !== input.reference.id
      )
        return failure(
          'idempotency_conflict',
          'idempotency key is already assigned to another cache deletion',
          409,
        );
      const existing = [
        ...this.ctx.storage.sql.exec<{ operation_id: string }>(
          'SELECT operation_id FROM delete_operations WHERE cache_id = ?',
          input.reference.id,
        ),
      ][0];
      if (existing)
        return {
          ok: true as const,
          value: {
            operation_id: String(existing.operation_id),
            repeated: true,
          },
        };
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
      return {
        ok: true as const,
        value: { operation_id: input.operation_id, repeated: false },
      };
    });
  }

  async removeCache(value: CacheReference): Promise<RpcResult<void>> {
    return this.ctx.storage.transactionSync(() => {
      const row = [
        ...this.ctx.storage.sql.exec<{ lifecycle: string }>(
          'SELECT lifecycle FROM caches WHERE cache_id = ? AND incarnation = ?',
          value.id,
          value.incarnation,
        ),
      ][0];
      // Removal is a retried workflow step. A lost response can cause the
      // catalog mutation to be submitted again after it already committed;
      // absence is therefore the desired idempotent result.
      if (!row) return { ok: true, value: undefined };
      if (row.lifecycle !== 'DELETING')
        return failure(
          'cache_not_deleting',
          'cache must be deleting before removal',
          409,
        );
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
      return { ok: true as const, value: undefined };
    });
  }

  async listCaches(input: {
    after: string | null;
    limit: number;
  }): Promise<
    RpcResult<{ items: CacheReference[]; next_after: string | null }>
  > {
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 100);
    const rows = [
      ...this.ctx.storage.sql.exec<SqlRow>(
        input.after
          ? 'SELECT cache_id, name, incarnation, coordinator_id, lifecycle FROM caches WHERE name > ? ORDER BY name LIMIT ?'
          : 'SELECT cache_id, name, incarnation, coordinator_id, lifecycle FROM caches ORDER BY name LIMIT ?',
        ...(input.after ? [input.after, limit + 1] : [limit + 1]),
      ),
    ];
    const page = rows.slice(0, limit).map(reference);
    return {
      ok: true,
      value: {
        items: page,
        next_after: rows.length > limit ? (page.at(-1)?.name ?? null) : null,
      },
    };
  }

  fetch(): Response {
    return Response.json({ code: 'rpc_only' }, { status: 404 });
  }
}

function reference(row: SqlRow): CacheReference {
  return {
    id: String(row.cache_id),
    name: String(row.name),
    incarnation: String(row.incarnation),
    coordinator_id: String(row.coordinator_id),
    lifecycle: row.lifecycle
      ? (String(row.lifecycle) as CacheReference['lifecycle'])
      : undefined,
  };
}
