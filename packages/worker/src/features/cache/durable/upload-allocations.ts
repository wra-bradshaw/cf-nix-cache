import { type RpcResult, failure, ok } from '../../../shared/rpc';
import {
  first,
  type SqlRow,
  text,
  integer,
  pageCursor,
} from '../../../shared/sql';
import { lifecycleFailure } from '../access';

const INFLIGHT_TTL_SECONDS = 60 * 60;

export const INFLIGHT_SCHEMA = `CREATE TABLE IF NOT EXISTS inflight_uploads (
  store_hash TEXT PRIMARY KEY, nar_hash TEXT NOT NULL, upload_id TEXT NOT NULL, created_at INTEGER NOT NULL
);`;

const chunksKey = (id: string) => `staging/${id}.chunks.json`;

export interface Allocation {
  id: string;
  chunks_key: string;
  repeated: boolean;
  merged: boolean;
}

export interface AllocationRequest {
  operation_id: string;
  fingerprint: string;
  store_hash: string;
  nar_hash: string;
  now: number;
  merge: boolean;
  replace?: string;
}

export class UploadAllocations {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async allocate(input: AllocationRequest): Promise<RpcResult<Allocation>> {
    if (typeof input.now !== 'number' || !Number.isFinite(input.now))
      return failure('invalid_now', 'now must be a finite timestamp', 400);
    return this.ctx.storage.transactionSync(() => {
      const cache = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT lifecycle FROM cache LIMIT 1',
        ),
      );
      if (!cache) return failure('not_found', 'cache not found', 404);
      try {
        const blocked = lifecycleFailure(text(cache, 'lifecycle'));
        if (blocked)
          return failure(blocked.code, blocked.message, blocked.status);
      } catch {
        return failure('corrupt_cache', 'cache record is corrupt', 500);
      }
      const old = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT fingerprint, upload_id, staging_key FROM upload_allocations WHERE operation_id = ?',
          input.operation_id,
        ),
      );
      if (old) {
        try {
          if (text(old, 'fingerprint') !== input.fingerprint)
            return failure(
              'idempotency_conflict',
              'idempotency key was reused with different upload metadata',
              409,
            );
          return ok({
            id: text(old, 'upload_id'),
            chunks_key: text(old, 'staging_key'),
            repeated: true,
            merged: false,
          });
        } catch {
          return failure('corrupt_cache', 'cache record is corrupt', 500);
        }
      }
      if (input.replace)
        this.ctx.storage.sql.exec(
          'DELETE FROM inflight_uploads WHERE store_hash = ? AND upload_id = ?',
          input.store_hash,
          input.replace,
        );
      let inflight: { nar_hash: string; upload_id: string } | undefined;
      try {
        inflight = this.inflight(input.store_hash, input.now);
      } catch {
        return failure('corrupt_cache', 'cache record is corrupt', 500);
      }
      if (inflight && inflight.nar_hash === input.nar_hash && input.merge)
        return ok({
          id: inflight.upload_id,
          chunks_key: chunksKey(inflight.upload_id),
          repeated: false,
          merged: true,
        });
      const id = this.env.UPLOAD_JOB!.newUniqueId().toString();
      const key = chunksKey(id);
      this.ctx.storage.sql.exec(
        'INSERT INTO upload_allocations (operation_id, fingerprint, upload_id, staging_key, created_at) VALUES (?, ?, ?, ?, ?)',
        input.operation_id,
        input.fingerprint,
        id,
        key,
        input.now,
      );
      if (!inflight || inflight.nar_hash !== input.nar_hash)
        this.ctx.storage.sql.exec(
          'INSERT OR REPLACE INTO inflight_uploads (store_hash, nar_hash, upload_id, created_at) VALUES (?, ?, ?, ?)',
          input.store_hash,
          input.nar_hash,
          id,
          input.now,
        );
      return ok({
        id,
        chunks_key: key,
        repeated: false,
        merged: false,
      });
    });
  }

  async pending(input: {
    store_hashes: string[];
    now: number;
  }): Promise<RpcResult<{ store_hash: string; upload_id: string }[]>> {
    if (typeof input.now !== 'number' || !Number.isFinite(input.now))
      return failure('invalid_now', 'now must be a finite timestamp', 400);
    const result: { store_hash: string; upload_id: string }[] = [];
    for (const storeHash of input.store_hashes) {
      let row: { nar_hash: string; upload_id: string } | undefined;
      try {
        row = this.inflight(storeHash, input.now);
      } catch (error) {
        console.warn({
          message: 'ignoring corrupt inflight upload',
          store_hash: storeHash,
          error: error instanceof Error ? error.message : error,
        });
        continue;
      }
      if (row) result.push({ store_hash: storeHash, upload_id: row.upload_id });
    }
    return ok(result);
  }

  async release(input: {
    store_hash: string;
    upload_id: string;
  }): Promise<RpcResult<void>> {
    this.ctx.storage.transactionSync(() =>
      this.ctx.storage.sql.exec(
        'DELETE FROM inflight_uploads WHERE store_hash = ? AND upload_id = ?',
        input.store_hash,
        input.upload_id,
      ),
    );
    return ok();
  }

  // Allocations older than `before`, for pruning. Each one's upload job is
  // purged before the allocation is forgotten.
  async stale(input: {
    before: number;
    after: string | null;
    limit: number;
  }): Promise<RpcResult<{ upload_ids: string[]; next_after: string | null }>> {
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
        'SELECT upload_id FROM upload_allocations WHERE created_at < ? AND upload_id > ? ORDER BY upload_id LIMIT ?',
        input.before,
        input.after ?? '',
        input.limit + 1,
      ),
    ];
    try {
      return ok({
        upload_ids: rows
          .slice(0, input.limit)
          .map((row) => text(row, 'upload_id')),
        next_after: pageCursor(rows, input.limit, (row) =>
          text(row, 'upload_id'),
        ),
      });
    } catch {
      return failure('corrupt_cache', 'cache record is corrupt', 500);
    }
  }

  // A retry with a forgotten idempotency key starts a new upload, which is
  // safe: the key's client gave up long before.
  async forget(input: { upload_ids: string[] }): Promise<RpcResult<void>> {
    this.ctx.storage.transactionSync(() => {
      for (const uploadId of input.upload_ids)
        this.ctx.storage.sql.exec(
          'DELETE FROM upload_allocations WHERE upload_id = ?',
          uploadId,
        );
    });
    return ok();
  }

  private inflight(
    storeHash: string,
    now: number,
  ): { nar_hash: string; upload_id: string } | undefined {
    const row = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT nar_hash, upload_id, created_at FROM inflight_uploads WHERE store_hash = ?',
        storeHash,
      ),
    );
    if (!row || integer(row, 'created_at') <= now - INFLIGHT_TTL_SECONDS)
      return undefined;
    return {
      nar_hash: text(row, 'nar_hash'),
      upload_id: text(row, 'upload_id'),
    };
  }
}
