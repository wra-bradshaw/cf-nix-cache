import type { CacheMutation, PathRecord, PreparedMutation } from '../types';
import { type RpcResult, conflict, failure, ok } from '../../../shared/rpc';
import {
  addMissingColumns,
  first,
  type SqlRow,
  text,
  integer,
  json,
  pageCursor,
} from '../../../shared/sql';
import { now } from '../../../shared/clock';
import { RpcOnlyDurableObject } from '../../../shared/rpc-only-durable-object';

const HOUR_SECONDS = 60 * 60;
const TOUCH_INTERVAL_SECONDS = HOUR_SECONDS;

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
    // Rows from before created_at existed have NULL, which pruning treats as
    // old.
    addMissingColumns(ctx, 'index_operations', { created_at: 'INTEGER' });
  }

  // Every lookup is a use of the path. Recording it in the same transaction
  // means an eviction either commits before the lookup, which then finds
  // nothing, or sees an access time at or after its cutoff and refuses (see
  // `usedSince`). The write is skipped within TOUCH_INTERVAL_SECONDS of the
  // last one, which is safe because every eviction cutoff is at least a day
  // old: retention and the eviction floor are whole days.
  async lookup(storeHash: string): Promise<RpcResult<PathRecord>> {
    return this.ctx.storage.transactionSync(() => {
      const row = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT record FROM paths WHERE store_hash = ?',
          storeHash,
        ),
      );
      if (!row) return failure('not_found', 'path not found', 404);
      this.ctx.storage.sql.exec(
        'UPDATE paths SET last_accessed = ? WHERE store_hash = ? AND last_accessed < ?',
        now(),
        storeHash,
        now() - TOUCH_INTERVAL_SECONDS,
      );
      try {
        return ok(json<PathRecord>(row, 'record'));
      } catch {
        return failure('corrupt_path', `path ${storeHash} is corrupt`, 500);
      }
    });
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
          'SELECT record, last_accessed FROM paths WHERE store_hash = ?',
          storeHash,
        ),
      );
      const inUse = usedSince(input.mutation, previousRow);
      if (inUse) return inUse;
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
        "INSERT INTO index_operations (operation_id, store_hash, mutation, previous, next_record, delta, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'PREPARED', ?)",
        input.operation_id,
        storeHash,
        mutationJson,
        previous ? JSON.stringify(previous) : null,
        next ? JSON.stringify(next) : null,
        delta,
        now(),
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
      const inUse = usedSince(
        mutation,
        first(
          this.ctx.storage.sql.exec<SqlRow>(
            'SELECT last_accessed FROM paths WHERE store_hash = ?',
            mutation.kind === 'upsert'
              ? mutation.record.store_hash
              : mutation.store_hash,
          ),
        ),
      );
      if (inUse) {
        this.ctx.storage.sql.exec(
          "UPDATE index_operations SET status = 'ABORTED' WHERE operation_id = ? AND status = 'PREPARED'",
          operationId,
        );
        return inUse;
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

  private committedOperationIds(): string[] {
    return [
      ...this.ctx.storage.sql.exec<SqlRow>(
        "SELECT operation_id FROM index_operations WHERE status = 'COMMITTED' AND store_hash IS NOT NULL",
      ),
    ].map((row) => text(row, 'operation_id'));
  }

  // Bytes of paths last used before `before`, by hour of last use. Eviction
  // adds these up across shards to find the cutoff that frees enough.
  async accessHistogram(input: {
    before: number;
  }): Promise<RpcResult<[hour: number, bytes: number][]>> {
    if (typeof input.before !== 'number' || !Number.isFinite(input.before))
      return failure(
        'invalid_before',
        'before must be a finite timestamp',
        400,
      );
    try {
      return ok(
        [
          ...this.ctx.storage.sql.exec<SqlRow>(
            `SELECT last_accessed / ${HOUR_SECONDS} AS hour, SUM(file_size) AS bytes
             FROM paths WHERE last_accessed < ? GROUP BY hour`,
            input.before,
          ),
        ].map((row) => [integer(row, 'hour'), integer(row, 'bytes')]),
      );
    } catch {
      return failure('corrupt_path', 'index shard record is corrupt', 500);
    }
  }

  // Settled path operations older than `before`. Their rows only serve
  // retries of the same operation ID, which stop long before this.
  async staleOperations(input: {
    before: number;
    after: string | null;
    limit: number;
  }): Promise<
    RpcResult<{ operation_ids: string[]; next_after: string | null }>
  > {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000)
      return failure('invalid_limit', 'limit must be between 1 and 1000', 400);
    if (typeof input.before !== 'number' || !Number.isFinite(input.before))
      return failure(
        'invalid_before',
        'before must be a finite timestamp',
        400,
      );
    const rows = [
      ...this.ctx.storage.sql.exec<SqlRow>(
        `SELECT operation_id FROM index_operations
         WHERE status IN ('COMMITTED', 'ABORTED') AND store_hash IS NOT NULL
           AND (created_at IS NULL OR created_at < ?) AND operation_id > ?
         ORDER BY operation_id LIMIT ?`,
        input.before,
        input.after ?? '',
        input.limit + 1,
      ),
    ];
    try {
      return ok({
        operation_ids: rows
          .slice(0, input.limit)
          .map((row) => text(row, 'operation_id')),
        next_after: pageCursor(rows, input.limit, (row) =>
          text(row, 'operation_id'),
        ),
      });
    } catch {
      return failure(
        'corrupt_operation',
        'index operation record is corrupt',
        500,
      );
    }
  }

  // Never removes a PREPARED row, which holds the path's lock, or the record
  // of a cache clear.
  async forgetOperations(input: {
    operation_ids: string[];
  }): Promise<RpcResult<void>> {
    this.ctx.storage.transactionSync(() => {
      for (const operationId of input.operation_ids)
        this.ctx.storage.sql.exec(
          "DELETE FROM index_operations WHERE operation_id = ? AND status IN ('COMMITTED', 'ABORTED') AND store_hash IS NOT NULL",
          operationId,
        );
    });
    return ok();
  }

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

  async expiredPaths(input: {
    before: number;
    after: string | null;
    limit: number;
  }): Promise<RpcResult<{ hashes: string[]; next_after: string | null }>> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000)
      return failure('invalid_limit', 'limit must be between 1 and 1000', 400);
    if (typeof input.before !== 'number' || !Number.isFinite(input.before))
      return failure(
        'invalid_before',
        'before must be a finite timestamp',
        400,
      );
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

function usedSince(
  mutation: Mutation,
  row: SqlRow | undefined,
): RpcResult<never> | null {
  if (mutation.kind !== 'delete' || mutation.unused_before === undefined)
    return null;
  if (!row) return null;
  let lastAccessed: number;
  try {
    lastAccessed = integer(row, 'last_accessed');
  } catch {
    return failure('corrupt_path', 'index shard record is corrupt', 500);
  }
  return lastAccessed >= mutation.unused_before
    ? failure('path_in_use', 'path was used after the eviction cutoff', 409)
    : null;
}

function preparedStatus(value: string): Prepared['status'] {
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
