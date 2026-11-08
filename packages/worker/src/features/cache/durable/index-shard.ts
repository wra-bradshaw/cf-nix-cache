import type { CacheMutation, PathRecord, PreparedMutation } from '../types';
import { type RpcResult, conflict, failure, ok } from '../../../shared/rpc';
import {
  first,
  type SqlRow,
  text,
  integer,
  json,
  pageCursor,
} from '../../../shared/sql';
import { now } from '../../../shared/clock';
import { RpcOnlyDurableObject } from '../../../shared/rpc-only-durable-object';

const TOUCH_INTERVAL_SECONDS = 60 * 60;

type Mutation = Exclude<CacheMutation, { kind: 'clear' }>;
type Prepared = Omit<PreparedMutation, 'cache' | 'store_hash'>;

function deltaFor(
  next: PathRecord | null,
  previous: PathRecord | null,
): number {
  return (next?.file_size ?? 0) - (previous?.file_size ?? 0);
}

export class CacheIndexShard extends RpcOnlyDurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS paths (
      store_hash TEXT PRIMARY KEY, record TEXT NOT NULL, file_size INTEGER NOT NULL,
      last_accessed INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS paths_lru ON paths(last_accessed);
    CREATE TABLE IF NOT EXISTS index_operations (
      operation_id TEXT PRIMARY KEY, store_hash TEXT, mutation TEXT NOT NULL,
      previous TEXT, next_record TEXT, delta INTEGER NOT NULL, status TEXT NOT NULL,
      clear_deleted INTEGER NOT NULL DEFAULT 0, clear_bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS index_store_lock ON index_operations(store_hash) WHERE status = 'PREPARED';
    CREATE TABLE IF NOT EXISTS deletion_fence (
      key INTEGER PRIMARY KEY CHECK (key = 1), operation_id TEXT NOT NULL
    );`);
  }

  async lookup(storeHash: string): Promise<RpcResult<PathRecord>> {
    const row = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT record FROM paths WHERE store_hash = ?',
        storeHash,
      ),
    );
    if (!row) return failure('not_found', 'path not found', 404);
    try {
      return ok(json<PathRecord>(row, 'record'));
    } catch {
      return failure('corrupt_path', `path ${storeHash} is corrupt`, 500);
    }
  }

  async prepare(input: {
    operation_id: string;
    mutation: Mutation;
  }): Promise<RpcResult<Prepared>> {
    return this.ctx.storage.transactionSync(() => {
      const mutationJson = JSON.stringify(input.mutation);
      const existing = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT operation_id, mutation, previous, next_record, delta, status FROM index_operations WHERE operation_id = ?',
          input.operation_id,
        ),
      );
      if (existing) {
        try {
          if (text(existing, 'mutation') !== mutationJson)
            return conflict(
              'operation_conflict',
              'index mutation changed during retry',
            );
          return ok(toPrepared(existing));
        } catch {
          return failure(
            'corrupt_operation',
            'index operation record is corrupt',
            500,
          );
        }
      }
      const fenced = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT operation_id FROM deletion_fence WHERE key = 1',
        ),
      );
      if (fenced)
        return failure(
          'cache_deleting',
          'cache index is fenced for deletion',
          410,
        );
      const storeHash =
        input.mutation.kind === 'upsert'
          ? input.mutation.record.store_hash
          : input.mutation.store_hash;
      const previousRow = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT record FROM paths WHERE store_hash = ?',
          storeHash,
        ),
      );
      let previous: PathRecord | null;
      try {
        previous = previousRow ? json<PathRecord>(previousRow, 'record') : null;
      } catch {
        return failure('corrupt_path', `path ${storeHash} is corrupt`, 500);
      }
      const next =
        input.mutation.kind === 'upsert' ? input.mutation.record : null;
      const delta = deltaFor(next, previous);
      const lock = first(
        this.ctx.storage.sql.exec<SqlRow>(
          "SELECT operation_id FROM index_operations WHERE store_hash = ? AND status = 'PREPARED'",
          storeHash,
        ),
      );
      if (lock) {
        let lockId: string;
        try {
          lockId = text(lock, 'operation_id');
        } catch {
          return failure(
            'corrupt_operation',
            'index operation record is corrupt',
            500,
          );
        }
        if (lockId !== input.operation_id)
          return failure(
            'mutation_in_progress',
            'another mutation is in progress for this path',
            409,
          );
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO index_operations (operation_id, store_hash, mutation, previous, next_record, delta, status) VALUES (?, ?, ?, ?, ?, ?, 'PREPARED')",
        input.operation_id,
        storeHash,
        mutationJson,
        previous ? JSON.stringify(previous) : null,
        next ? JSON.stringify(next) : null,
        delta,
      );
      return ok({
        operation_id: input.operation_id,
        delta,
        previous,
        record: next,
        status: 'PREPARED',
      });
    });
  }

  async commit(operationId: string): Promise<RpcResult<Prepared>> {
    return this.ctx.storage.transactionSync(() => {
      const row = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT * FROM index_operations WHERE operation_id = ?',
          operationId,
        ),
      );
      if (!row)
        return failure('operation_not_found', 'index operation not found', 404);
      let status: string;
      try {
        status = text(row, 'status');
      } catch {
        return failure(
          'corrupt_operation',
          'index operation record is corrupt',
          500,
        );
      }
      if (status === 'COMMITTED') {
        try {
          return ok(toPrepared(row));
        } catch {
          return failure(
            'corrupt_operation',
            'index operation record is corrupt',
            500,
          );
        }
      }
      if (status === 'ABORTED')
        return failure('operation_aborted', 'index operation was aborted', 409);
      if (status !== 'PREPARED')
        return failure(
          'corrupt_operation',
          'index operation record is corrupt',
          500,
        );
      const fenced = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT operation_id FROM deletion_fence WHERE key = 1',
        ),
      );
      if (fenced) {
        this.ctx.storage.sql.exec(
          "UPDATE index_operations SET status = 'ABORTED' WHERE operation_id = ? AND status = 'PREPARED'",
          operationId,
        );
        return failure(
          'cache_deleting',
          'cache index is fenced for deletion',
          410,
        );
      }
      let mutation: Mutation;
      try {
        mutation = json<Mutation>(row, 'mutation');
      } catch {
        return failure(
          'corrupt_operation',
          'index operation record is corrupt',
          500,
        );
      }
      if (mutation.kind === 'upsert')
        this.ctx.storage.sql.exec(
          'INSERT OR REPLACE INTO paths (store_hash, record, file_size, last_accessed, created_at) VALUES (?, ?, ?, ?, ?)',
          mutation.record.store_hash,
          JSON.stringify(mutation.record),
          mutation.record.file_size,
          mutation.record.last_accessed,
          mutation.record.created_at,
        );
      else
        this.ctx.storage.sql.exec(
          'DELETE FROM paths WHERE store_hash = ?',
          mutation.store_hash,
        );
      this.ctx.storage.sql.exec(
        "UPDATE index_operations SET status = 'COMMITTED' WHERE operation_id = ? AND status = 'PREPARED'",
        operationId,
      );
      try {
        return ok(toPrepared({ ...row, status: 'COMMITTED' }));
      } catch {
        return failure(
          'corrupt_operation',
          'index operation record is corrupt',
          500,
        );
      }
    });
  }

  async abort(operationId: string): Promise<RpcResult<void>> {
    this.ctx.storage.transactionSync(() =>
      this.ctx.storage.sql.exec(
        "UPDATE index_operations SET status = 'ABORTED' WHERE operation_id = ? AND status = 'PREPARED'",
        operationId,
      ),
    );
    return ok();
  }

  async clear(operationId: string): Promise<
    RpcResult<{
      deleted: number;
      bytes: number;
      reconcile_operation_ids: string[];
    }>
  > {
    return this.ctx.storage.transactionSync(() => {
      const old = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT mutation, clear_deleted, clear_bytes, status FROM index_operations WHERE operation_id = ?',
          operationId,
        ),
      );
      if (old) {
        try {
          // prepare() and clear() share the index_operations primary key, so
          // an id reused across mutation kinds must not read back as a
          // clear result: a prepare row carries clear_deleted/clear_bytes
          // defaults of 0/0. Reject the reuse instead of reporting 0/0.
          const kind = (json(old, 'mutation') as { kind?: unknown }).kind;
          if (kind !== 'clear')
            return conflict(
              'operation_conflict',
              'operation id was used by a different mutation',
            );
          return ok({
            deleted: integer(old, 'clear_deleted'),
            bytes: integer(old, 'clear_bytes'),
            reconcile_operation_ids: this.committedOperationIds(),
          });
        } catch {
          return failure(
            'corrupt_operation',
            'index operation record is corrupt',
            500,
          );
        }
      }
      this.ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO deletion_fence (key, operation_id) VALUES (1, ?)',
        operationId,
      );
      this.ctx.storage.sql.exec(
        "UPDATE index_operations SET status = 'ABORTED' WHERE status = 'PREPARED'",
      );
      // COUNT(*) always returns exactly one row in SQLite: a missing row
      // means the count itself is unreadable, so fail closed (corrupt) rather
      // than reporting 0/0 and letting teardown proceed with unknown bytes.
      // Uses first() (not .one()): .one() throws on an empty cursor, which
      // would escape the transaction instead of returning corrupt_operation.
      const totals = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT COUNT(*) AS count, COALESCE(SUM(file_size), 0) AS bytes FROM paths',
        ),
      );
      if (!totals)
        return failure(
          'corrupt_operation',
          'index operation record is corrupt',
          500,
        );
      let deleted: number;
      let bytes: number;
      try {
        deleted = integer(totals, 'count');
        bytes = integer(totals, 'bytes');
      } catch {
        return failure(
          'corrupt_operation',
          'index operation record is corrupt',
          500,
        );
      }
      // Compute before mutation: committedOperationIds() reads and parses
      // rows, so a corrupt row must fail before DELETE/INSERT mutate state.
      // Computing after mutation would commit the clear and then return
      // corrupt_operation, leaving the shard cleared with no result.
      let reconcileIds: string[];
      try {
        reconcileIds = this.committedOperationIds();
      } catch {
        return failure(
          'corrupt_operation',
          'index operation record is corrupt',
          500,
        );
      }
      this.ctx.storage.sql.exec('DELETE FROM paths');
      this.ctx.storage.sql.exec(
        "INSERT INTO index_operations (operation_id, mutation, delta, status, clear_deleted, clear_bytes) VALUES (?, ?, ?, 'COMMITTED', ?, ?)",
        operationId,
        JSON.stringify({ kind: 'clear' }),
        -bytes,
        deleted,
        bytes,
      );
      return ok({
        deleted,
        bytes,
        reconcile_operation_ids: reconcileIds,
      });
    });
  }

  /**
   * Index commits and quota finalization are separate durable operations.
   * Teardown must finalize committed publications before debiting the shard.
   * Returning historical IDs is safe because quota finalization is idempotent.
   */
  private committedOperationIds(): string[] {
    return [
      ...this.ctx.storage.sql.exec<SqlRow>(
        "SELECT operation_id FROM index_operations WHERE status = 'COMMITTED' AND store_hash IS NOT NULL",
      ),
    ].map((row) => text(row, 'operation_id'));
  }

  async touch(storeHash: string): Promise<RpcResult<void>> {
    this.ctx.storage.transactionSync(() =>
      this.ctx.storage.sql.exec(
        // Throttled: this runs on every narinfo and push check, and retention
        // is measured in days.
        'UPDATE paths SET last_accessed = ? WHERE store_hash = ? AND last_accessed < ?',
        now(),
        storeHash,
        now() - TOUCH_INTERVAL_SECONDS,
      ),
    );
    return ok();
  }

  /** One page of the manifests that this shard's paths depend on. */
  async manifestKeys(input: {
    after: string | null;
    limit: number;
  }): Promise<RpcResult<{ keys: string[]; next_after: string | null }>> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000)
      return failure('invalid_limit', 'limit must be between 1 and 1000', 400);
    if (input.after !== null && typeof input.after !== 'string')
      return failure('invalid_after', 'after must be a string or null', 400);
    const limit = input.limit;
    const rows = [
      ...this.ctx.storage.sql.exec<SqlRow>(
        "SELECT store_hash, json_extract(record, '$.manifest_key') AS manifest_key FROM paths WHERE store_hash > ? ORDER BY store_hash LIMIT ?",
        input.after ?? '',
        limit + 1,
      ),
    ];
    const keys: string[] = [];
    try {
      for (const row of rows.slice(0, limit)) {
        // Garbage collection must not guess at what a path depends on.
        const storeHash = text(row, 'store_hash');
        let manifest: string;
        try {
          manifest = text(row, 'manifest_key');
        } catch {
          return failure(
            'corrupt_path',
            `path ${storeHash} has no manifest`,
            500,
          );
        }
        if (!manifest)
          return failure(
            'corrupt_path',
            `path ${storeHash} has no manifest`,
            500,
          );
        keys.push(manifest);
      }
      return ok({
        keys,
        next_after: pageCursor(rows, limit, (row) => text(row, 'store_hash')),
      });
    } catch {
      return failure('corrupt_path', 'index shard record is corrupt', 500);
    }
  }

  /**
   * One page of paths unused since `before`. Paged by store hash, which never
   * changes, so a path that cannot be evicted is passed over rather than seen
   * again, and a concurrent touch cannot make the walk skip anything.
   */
  async expiredPaths(input: {
    before: number;
    after: string | null;
    limit: number;
  }): Promise<RpcResult<{ hashes: string[]; next_after: string | null }>> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000)
      return failure('invalid_limit', 'limit must be between 1 and 1000', 400);
    if (typeof input.before !== 'number' || !Number.isFinite(input.before))
      return failure('invalid_before', 'before must be a finite timestamp', 400);
    if (input.after !== null && typeof input.after !== 'string')
      return failure('invalid_after', 'after must be a string or null', 400);
    const limit = input.limit;
    const rows = [
      ...this.ctx.storage.sql.exec<SqlRow>(
        'SELECT store_hash FROM paths WHERE last_accessed < ? AND store_hash > ? ORDER BY store_hash LIMIT ?',
        input.before,
        input.after ?? '',
        limit + 1,
      ),
    ];
    try {
      return ok({
        hashes: rows.slice(0, limit).map((row) => text(row, 'store_hash')),
        next_after: pageCursor(rows, limit, (row) => text(row, 'store_hash')),
      });
    } catch {
      return failure('corrupt_path', 'index shard record is corrupt', 500);
    }
  }
}

function preparedStatus(value: string): Prepared['status'] {
  // Allow-list from PreparedMutation (`PREPARED`/`COMMITTED`/`ABORTED`): any
  // other stored value is a corrupt row, not a migration to preserve. A bare
  // `as Prepared['status']` cast would accept e.g. 'PREPARED ' or 'deleted'.
  if (value === 'PREPARED' || value === 'COMMITTED' || value === 'ABORTED')
    return value;
  throw new Error(`index operation status ${value} is not a known status`);
}

function toPrepared(row: SqlRow): Prepared {
  return {
    operation_id: text(row, 'operation_id'),
    delta: integer(row, 'delta'),
    previous: row.previous == null ? null : json<PathRecord>(row, 'previous'),
    record:
      row.next_record == null ? null : json<PathRecord>(row, 'next_record'),
    status: preparedStatus(text(row, 'status')),
  };
}
