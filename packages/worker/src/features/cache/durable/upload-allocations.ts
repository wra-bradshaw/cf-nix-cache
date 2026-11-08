import { type RpcResult, failure, ok } from '../../../shared/rpc';
import { first, type SqlRow, text, integer } from '../../../shared/sql';
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
        'INSERT INTO upload_allocations (operation_id, fingerprint, upload_id, staging_key) VALUES (?, ?, ?, ?)',
        input.operation_id,
        input.fingerprint,
        id,
        key,
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
