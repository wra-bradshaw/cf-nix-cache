import type { PathRecord } from '../types';
import { type RpcResult, failure, ok } from '../../../shared/rpc';
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

const HOUR_SECONDS = 60 * 60;
const TOUCH_INTERVAL_SECONDS = HOUR_SECONDS;

interface Usage {
  bytes: number;
  revision: number;
}

export class CacheIndexShard extends RpcOnlyDurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS paths (
      store_hash TEXT PRIMARY KEY, record TEXT NOT NULL, file_size INTEGER NOT NULL,
      last_accessed INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS paths_lru ON paths(last_accessed);
    CREATE TABLE IF NOT EXISTS state (
      key INTEGER PRIMARY KEY CHECK (key = 1),
      fenced INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO state (key, fenced, revision) VALUES (1, 0, 0);`);
  }

  // Every lookup is a use of the path. Recording it in the same transaction
  // means an eviction either commits before the lookup, which then finds
  // nothing, or sees an access time at or after its cutoff and refuses.
  // The write is skipped within TOUCH_INTERVAL_SECONDS of the last one, which
  // is safe because every eviction cutoff is at least a day old: retention
  // and the eviction floor are whole days.
  async lookup(storeHash: string): Promise<RpcResult<PathRecord>> {
    return this.transact(() => {
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

  async upsert(
    record: PathRecord,
  ): Promise<RpcResult<{ previous_size: number | null } & Usage>> {
    return this.transact(() => {
      if (this.fenced())
        return failure(
          'cache_deleting',
          'cache index is fenced for deletion',
          410,
        );
      const previous = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT file_size FROM paths WHERE store_hash = ?',
          record.store_hash,
        ),
      );
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO paths (store_hash, record, file_size, last_accessed, created_at) VALUES (?, ?, ?, ?, ?)',
        record.store_hash,
        JSON.stringify(record),
        record.file_size,
        record.last_accessed,
        record.created_at,
      );
      this.bumpRevision();
      return ok({
        previous_size: previous ? integer(previous, 'file_size') : null,
        ...this.revisionAndBytes(),
      });
    });
  }

  async delete(input: {
    store_hash: string;
    unused_before?: number;
  }): Promise<RpcResult<{ freed: number; existed: boolean } & Usage>> {
    return this.transact<{ freed: number; existed: boolean } & Usage>(() => {
      const row = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT file_size, last_accessed FROM paths WHERE store_hash = ?',
          input.store_hash,
        ),
      );
      if (
        row &&
        input.unused_before !== undefined &&
        integer(row, 'last_accessed') >= input.unused_before
      )
        return failure(
          'path_in_use',
          'path was used after the eviction cutoff',
          409,
        );
      if (!row)
        return ok({ freed: 0, existed: false, ...this.revisionAndBytes() });
      const freed = integer(row, 'file_size');
      this.ctx.storage.sql.exec(
        'DELETE FROM paths WHERE store_hash = ?',
        input.store_hash,
      );
      this.bumpRevision();
      return ok({ freed, existed: true, ...this.revisionAndBytes() });
    });
  }

  async clear(): Promise<
    RpcResult<{ deleted: number; bytes: number; revision: number }>
  > {
    return this.transact(() => {
      this.ctx.storage.sql.exec('UPDATE state SET fenced = 1 WHERE key = 1');
      const totals = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT COUNT(*) AS count, COALESCE(SUM(file_size), 0) AS bytes FROM paths',
        ),
      );
      if (!totals) throw new Error('index shard totals are missing');
      const deleted = integer(totals, 'count');
      const bytes = integer(totals, 'bytes');
      this.ctx.storage.sql.exec('DELETE FROM paths');
      this.bumpRevision();
      return ok({ deleted, bytes, revision: this.revisionAndBytes().revision });
    });
  }

  async usage(): Promise<RpcResult<Usage>> {
    return this.transact(() => ok(this.revisionAndBytes()));
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

  private transact<T>(body: () => RpcResult<T>): RpcResult<T> {
    try {
      return this.ctx.storage.transactionSync(body);
    } catch {
      return failure('corrupt_path', 'index shard record is corrupt', 500);
    }
  }

  private fenced(): boolean {
    const row = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT fenced FROM state WHERE key = 1',
      ),
    );
    if (!row) throw new Error('index shard state row is missing');
    return integer(row, 'fenced') === 1;
  }

  private bumpRevision(): void {
    this.ctx.storage.sql.exec(
      'UPDATE state SET revision = revision + 1 WHERE key = 1',
    );
  }

  private revisionAndBytes(): Usage {
    const totals = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT COALESCE(SUM(file_size), 0) AS bytes FROM paths',
      ),
    );
    const state = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT revision FROM state WHERE key = 1',
      ),
    );
    if (!totals || !state) throw new Error('index shard state row is missing');
    return {
      bytes: integer(totals, 'bytes'),
      revision: integer(state, 'revision'),
    };
  }
}
