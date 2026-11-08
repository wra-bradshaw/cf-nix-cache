import type { QuotaReservation } from '../types';
import { type RpcResult, failure, ok, conflict } from '../../../shared/rpc';
import { first, text, integer, type SqlRow } from '../../../shared/sql';
import { lifecycleFailure } from '../access';

function quotaStatus(value: string): QuotaReservation['status'] {
  // Allow-list from QuotaReservation (`RESERVED`/`FINALIZED`/`ABORTED`): any
  // other stored value is a corrupt row, not a migration to preserve. A bare
  // `as QuotaReservation['status']` cast would accept e.g. 'reserved'.
  if (value === 'RESERVED' || value === 'FINALIZED' || value === 'ABORTED')
    return value;
  throw new Error(`quota operation status ${value} is not a known status`);
}

export class CoordinatorQuota {
  constructor(private readonly ctx: DurableObjectState) {}

  async reserve(input: {
    operation_id: string;
    delta: number;
  }): Promise<RpcResult<QuotaReservation>> {
    // Creation-time shape check: a non-integer delta can never reserve, and
    // must surface as 400 (not quota_exceeded 409) so callers fix the input
    // rather than retrying for quota.
    if (!Number.isSafeInteger(input.delta))
      return failure(
        'invalid_quota',
        'quota delta must be a safe integer',
        400,
      );
    return this.ctx.storage.transactionSync(() => {
      // Reconcile an operation before checking lifecycle. A publication may
      // have committed its index mutation immediately before deletion fenced
      // the cache, and must still be allowed to finalize its already-created
      // reservation so the deletion workflow can make progress.
      const old = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT delta, status FROM quota_operations WHERE operation_id = ?',
          input.operation_id,
        ),
      );
      if (old) {
        try {
          if (integer(old, 'delta') !== input.delta)
            return conflict(
              'operation_conflict',
              'operation delta changed during retry',
            );
          return ok({
            operation_id: input.operation_id,
            delta: input.delta,
            status: quotaStatus(text(old, 'status')),
          });
        } catch {
          return failure('corrupt_cache', 'cache quota record is corrupt', 500);
        }
      }
      const cache = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT lifecycle, logical_bytes, quota_bytes FROM cache LIMIT 1',
        ),
      );
      if (!cache) return failure('not_found', 'cache not found', 404);
      let pending: number;
      try {
        const blocked = lifecycleFailure(text(cache, 'lifecycle'));
        if (blocked)
          return failure(blocked.code, blocked.message, blocked.status);
        const quotaBytes = integer(cache, 'quota_bytes');
        // Creation validation is enforced in catalog/coordinator, so a
        // non-positive or unsafe stored quota means the row is corrupt, not
        // that the caller exceeded quota. Fail closed rather than allowing
        // unbounded writes (quota 0) or mis-arithmetic.
        if (
          !Number.isSafeInteger(quotaBytes) ||
          quotaBytes < 1 ||
          quotaBytes > Number.MAX_SAFE_INTEGER
        )
          throw new Error('quota_bytes is not a valid quota');
        const pendingRow = first(
          this.ctx.storage.sql.exec<SqlRow>(
            "SELECT COALESCE(SUM(CASE WHEN status = 'RESERVED' AND delta > 0 THEN delta ELSE 0 END), 0) AS value FROM quota_operations",
          ),
        );
        // COALESCE(SUM(...)) always returns exactly one row in SQLite: a
        // missing row means the pending total itself is unreadable, so fail
        // closed (corrupt_cache 500) rather than treating unknown backlog
        // as 0 and allowing quota to be exceeded.
        if (!pendingRow) throw new Error('quota pending total is missing');
        pending = integer(pendingRow, 'value');
        if (
          integer(cache, 'logical_bytes') + pending + input.delta >
          quotaBytes
        )
          return failure('quota_exceeded', 'cache quota exceeded', 409);
        if (integer(cache, 'logical_bytes') + input.delta < 0)
          return failure('quota_invariant', 'quota would become negative', 409);
      } catch {
        return failure('corrupt_cache', 'cache quota record is corrupt', 500);
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO quota_operations (operation_id, delta, status) VALUES (?, ?, 'RESERVED')",
        input.operation_id,
        input.delta,
      );
      return ok({
        operation_id: input.operation_id,
        delta: input.delta,
        status: 'RESERVED',
      });
    });
  }

  async check(input: { delta: number }): Promise<RpcResult<void>> {
    if (!Number.isSafeInteger(input.delta))
      return failure(
        'invalid_quota',
        'quota delta must be a safe integer',
        400,
      );
    const cache = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT lifecycle, logical_bytes, quota_bytes FROM cache LIMIT 1',
      ),
    );
    if (!cache) return failure('not_found', 'cache not found', 404);
    try {
      const blocked = lifecycleFailure(text(cache, 'lifecycle'));
      if (blocked)
        return failure(blocked.code, blocked.message, blocked.status);
      const quotaBytes = integer(cache, 'quota_bytes');
      if (
        !Number.isSafeInteger(quotaBytes) ||
        quotaBytes < 1 ||
        quotaBytes > Number.MAX_SAFE_INTEGER
      )
        throw new Error('quota_bytes is not a valid quota');
      const pendingRow = first(
        this.ctx.storage.sql.exec<SqlRow>(
          "SELECT COALESCE(SUM(CASE WHEN status = 'RESERVED' AND delta > 0 THEN delta ELSE 0 END), 0) AS value FROM quota_operations",
        ),
      );
      // Same fail-closed rule as reserve(): COALESCE(SUM(...)) always returns
      // one row, so a missing row is corrupt, not zero backlog.
      if (!pendingRow) throw new Error('quota pending total is missing');
      const pending = integer(pendingRow, 'value');
      if (
        integer(cache, 'logical_bytes') + pending + input.delta >
          quotaBytes
      )
        return failure('quota_exceeded', 'cache quota exceeded', 409);
      if (integer(cache, 'logical_bytes') + input.delta < 0)
        return failure('quota_invariant', 'quota would become negative', 409);
      return ok();
    } catch {
      return failure('corrupt_cache', 'cache quota record is corrupt', 500);
    }
  }

  async finalize(input: { operation_id: string }): Promise<RpcResult<void>> {
    return this.ctx.storage.transactionSync(() => {
      const row = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT delta, status FROM quota_operations WHERE operation_id = ?',
          input.operation_id,
        ),
      );
      if (!row)
        return failure('operation_not_found', 'quota operation not found', 404);
      try {
        const status = quotaStatus(text(row, 'status'));
        if (status === 'FINALIZED') return ok();
        if (status === 'ABORTED')
          return failure(
            'operation_aborted',
            'quota operation was aborted',
            409,
          );
        const failed = this.finalizeRow(
          input.operation_id,
          integer(row, 'delta'),
        );
        if (failed) return failed;
        return ok();
      } catch {
        return failure('corrupt_cache', 'cache quota record is corrupt', 500);
      }
    });
  }

  async abort(input: { operation_id: string }): Promise<RpcResult<void>> {
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE quota_operations SET status = 'ABORTED' WHERE operation_id = ? AND status = 'RESERVED'",
        input.operation_id,
      );
      return ok();
    });
  }

  /**
   * Reconcile publications whose index commit became visible before quota
   * finalization. This is used by cache teardown after an index shard has been
   * fenced and before its bytes are removed from the logical quota total.
   */
  async reconcile(input: {
    operation_ids: string[];
  }): Promise<RpcResult<void>> {
    return this.ctx.storage.transactionSync(() => {
      // Per-entry fail-isolation like UploadAllocations.pending: one corrupt
      // quota row must not block unrelated publications. A corrupt entry is
      // skipped (with a warn) so healthy ids still finalize; a poison pill
      // still fails the batch as `corrupt_cache` after healthy work commits,
      // rather than silently returning ok with bytes unaccounted.
      let corrupt = false;
      for (const operationId of input.operation_ids) {
        try {
          const row = first(
            this.ctx.storage.sql.exec<SqlRow>(
              'SELECT delta, status FROM quota_operations WHERE operation_id = ?',
              operationId,
            ),
          );
          if (row && quotaStatus(text(row, 'status')) === 'RESERVED') {
            const failed = this.finalizeRow(operationId, integer(row, 'delta'));
            if (failed) return failed;
          }
        } catch (error) {
          corrupt = true;
          console.warn({
            message: 'ignoring corrupt quota operation during reconcile',
            operation_id: operationId,
            error: error instanceof Error ? error.message : error,
          });
          continue;
        }
      }
      if (corrupt)
        return failure('corrupt_cache', 'cache quota record is corrupt', 500);
      return ok();
    });
  }

  /**
   * Applies a RESERVED operation's delta and marks it FINALIZED. The reserve
   * check does not account for concurrent negative deltas, so recheck here:
   * two deletes that each pass reserve must not drive logical_bytes below
   * zero. Returns a failure instead of applying when the delta would do so.
   *
   * Single-DO assumption: each cache has exactly one coordinator, and every
   * logical_bytes mutation runs inside this DO's transactionSync, so the
   * read-modify-write here cannot interleave with another writer.
   */
  private finalizeRow(
    operationId: string,
    delta: number,
  ): RpcResult<void> | null {
    const cache = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT logical_bytes FROM cache LIMIT 1',
      ),
    );
    // A missing cache row is not corruption here: the cache may have been
    // removed while a publication was still finalizing. Report not_found 404
    // so the caller distinguishes it from a negative total, which is a
    // quota_invariant 409 below.
    if (!cache) return failure('not_found', 'cache not found', 404);
    let logical: number;
    try {
      logical = integer(cache, 'logical_bytes');
    } catch {
      return failure('corrupt_cache', 'cache quota record is corrupt', 500);
    }
    if (logical + delta < 0)
      return failure('quota_invariant', 'quota would become negative', 409);
    this.ctx.storage.sql.exec(
      'UPDATE cache SET logical_bytes = logical_bytes + ?',
      delta,
    );
    this.ctx.storage.sql.exec(
      "UPDATE quota_operations SET status = 'FINALIZED' WHERE operation_id = ? AND status = 'RESERVED'",
      operationId,
    );
    return null;
  }

  async clearDelta(input: {
    operation_id: string;
    delta: number;
  }): Promise<RpcResult<void>> {
    return this.ctx.storage.transactionSync(() => {
      if (input.delta > 0 || !Number.isSafeInteger(input.delta))
        return failure(
          'quota_invariant',
          'cache clear delta must be a negative safe integer',
          409,
        );
      const old = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT delta FROM clear_operations WHERE operation_id = ?',
          input.operation_id,
        ),
      );
      try {
        if (old)
          return integer(old, 'delta') === input.delta
            ? ok()
            : conflict(
                'operation_conflict',
                'clear operation delta changed during retry',
              );
        const cache = first(
          this.ctx.storage.sql.exec<SqlRow>(
            'SELECT logical_bytes FROM cache LIMIT 1',
          ),
        );
        // A missing cache row is not_found 404 (the cache may have been
        // removed); only a negative total is quota_invariant 409. Keep the
        // two distinct so teardown can tell "already gone" from "would go
        // negative". integer() throws still map to corrupt_cache 500 below.
        if (!cache) return failure('not_found', 'cache not found', 404);
        if (integer(cache, 'logical_bytes') + input.delta < 0)
          return failure(
            'quota_invariant',
            'cache bytes would become negative',
            409,
          );
      } catch {
        return failure('corrupt_cache', 'cache quota record is corrupt', 500);
      }
      this.ctx.storage.sql.exec(
        'UPDATE cache SET logical_bytes = logical_bytes + ?',
        input.delta,
      );
      this.ctx.storage.sql.exec(
        'INSERT INTO clear_operations (operation_id, delta) VALUES (?, ?)',
        input.operation_id,
        input.delta,
      );
      return ok();
    });
  }
}
