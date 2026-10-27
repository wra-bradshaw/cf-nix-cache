import { deltaFor } from '../../domain/uploads';
import type {
  CacheMutation,
  PathRecord,
  PreparedMutation,
} from '../../../types';
import type { RpcResult } from '../../../rpc';
import {
  failure,
  first,
  now,
  ok,
  type SqlRow,
} from '../../../infrastructure/durable/shared';
import { RpcOnlyDurableObject } from '../../../infrastructure/durable/rpc-only';

type Mutation = Exclude<CacheMutation, { kind: 'clear' }>;
type Prepared = Omit<PreparedMutation, 'cache' | 'store_hash'>;

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
      this.ctx.storage.sql.exec<{ record: string }>(
        'SELECT record FROM paths WHERE store_hash = ?',
        storeHash,
      ),
    );
    return row
      ? ok(JSON.parse(row.record) as PathRecord)
      : failure('not_found', 'path not found', 404);
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
        if (String(existing.mutation) !== mutationJson)
          return failure(
            'operation_conflict',
            'index mutation changed during retry',
            409,
          );
        return ok(toPrepared(existing));
      }
      const fenced = first(
        this.ctx.storage.sql.exec<{ operation_id: string }>(
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
        this.ctx.storage.sql.exec<{ record: string }>(
          'SELECT record FROM paths WHERE store_hash = ?',
          storeHash,
        ),
      );
      const previous = previousRow
        ? (JSON.parse(previousRow.record) as PathRecord)
        : null;
      const next =
        input.mutation.kind === 'upsert' ? input.mutation.record : null;
      const delta = deltaFor(next, previous);
      const lock = first(
        this.ctx.storage.sql.exec<{ operation_id: string }>(
          "SELECT operation_id FROM index_operations WHERE store_hash = ? AND status = 'PREPARED'",
          storeHash,
        ),
      );
      if (lock && lock.operation_id !== input.operation_id)
        return failure(
          'mutation_in_progress',
          'another mutation is in progress for this path',
          409,
        );
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
      if (row.status === 'COMMITTED') return ok(toPrepared(row));
      if (row.status === 'ABORTED')
        return failure('operation_aborted', 'index operation was aborted', 409);
      const fenced = first(
        this.ctx.storage.sql.exec<{ operation_id: string }>(
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
      const mutation = JSON.parse(String(row.mutation)) as Mutation;
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
      return ok(toPrepared({ ...row, status: 'COMMITTED' }));
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
        this.ctx.storage.sql.exec<{
          clear_deleted: number;
          clear_bytes: number;
          status: string;
        }>(
          'SELECT clear_deleted, clear_bytes, status FROM index_operations WHERE operation_id = ?',
          operationId,
        ),
      );
      if (old)
        return ok({
          deleted: Number(old.clear_deleted),
          bytes: Number(old.clear_bytes),
          reconcile_operation_ids: this.committedOperationIds(),
        });
      this.ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO deletion_fence (key, operation_id) VALUES (1, ?)',
        operationId,
      );
      this.ctx.storage.sql.exec(
        "UPDATE index_operations SET status = 'ABORTED' WHERE status = 'PREPARED'",
      );
      const totals = this.ctx.storage.sql
        .exec<{ count: number; bytes: number }>(
          'SELECT COUNT(*) AS count, COALESCE(SUM(file_size), 0) AS bytes FROM paths',
        )
        .one();
      const deleted = Number(totals.count);
      const bytes = Number(totals.bytes);
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
        reconcile_operation_ids: this.committedOperationIds(),
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
      ...this.ctx.storage.sql.exec<{ operation_id: string }>(
        "SELECT operation_id FROM index_operations WHERE status = 'COMMITTED' AND store_hash IS NOT NULL",
      ),
    ].map((row) => String(row.operation_id));
  }

  async touch(storeHash: string): Promise<RpcResult<void>> {
    this.ctx.storage.transactionSync(() =>
      this.ctx.storage.sql.exec(
        'UPDATE paths SET last_accessed = ? WHERE store_hash = ?',
        now(),
        storeHash,
      ),
    );
    return ok();
  }
}

function toPrepared(row: SqlRow): Prepared {
  return {
    operation_id: String(row.operation_id),
    delta: Number(row.delta),
    previous: row.previous
      ? (JSON.parse(String(row.previous)) as PathRecord)
      : null,
    record: row.next_record
      ? (JSON.parse(String(row.next_record)) as PathRecord)
      : null,
    status: String(row.status) as Prepared['status'],
  };
}
