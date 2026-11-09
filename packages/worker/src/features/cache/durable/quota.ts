import type { QuotaReservation } from '../types';
import { type RpcResult, failure, ok, conflict } from '../../../shared/rpc';
import { first, text, integer, type SqlRow } from '../../../shared/sql';
import { lifecycleFailure } from '../access';
import type { CoordinatorEviction } from './coordinator-eviction';

// `quota_reserved` is a partial index on RESERVED rows, so this reads only
// the reservations in flight, not every operation the cache has had.
export const QUOTA_RESERVED_INDEX =
  "CREATE INDEX IF NOT EXISTS quota_reserved ON quota_operations(status) WHERE status = 'RESERVED';";
const PENDING_RESERVATIONS =
  "SELECT COALESCE(SUM(delta), 0) AS value FROM quota_operations WHERE status = 'RESERVED' AND delta > 0";

function quotaStatus(value: string): QuotaReservation['status'] {
  if (value === 'RESERVED' || value === 'FINALIZED' || value === 'ABORTED')
    return value;
  throw new Error(`quota operation status ${value} is not a known status`);
}

export class CoordinatorQuota {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly eviction: CoordinatorEviction,
  ) {}

  async reserve(input: {
    operation_id: string;
    delta: number;
  }): Promise<RpcResult<QuotaReservation>> {
    if (!Number.isSafeInteger(input.delta))
      return failure(
        'invalid_quota',
        'quota delta must be a safe integer',
        400,
      );
    return this.ctx.storage.transactionSync(() => {
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
        if (
          !Number.isSafeInteger(quotaBytes) ||
          quotaBytes < 1 ||
          quotaBytes > Number.MAX_SAFE_INTEGER
        )
          throw new Error('quota_bytes is not a valid quota');
        const pendingRow = first(
          this.ctx.storage.sql.exec<SqlRow>(PENDING_RESERVATIONS),
        );
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
        this.ctx.storage.sql.exec<SqlRow>(PENDING_RESERVATIONS),
      );
      if (!pendingRow) throw new Error('quota pending total is missing');
      const pending = integer(pendingRow, 'value');
      if (integer(cache, 'logical_bytes') + pending + input.delta > quotaBytes)
        return failure('quota_exceeded', 'cache quota exceeded', 409);
      if (integer(cache, 'logical_bytes') + input.delta < 0)
        return failure('quota_invariant', 'quota would become negative', 409);
      return ok();
    } catch {
      return failure('corrupt_cache', 'cache quota record is corrupt', 500);
    }
  }

  async finalize(input: { operation_id: string }): Promise<RpcResult<void>> {
    const result = this.finalizeOperation(input);
    if (result.ok) await this.eviction.afterGrowth();
    return result;
  }

  private finalizeOperation(input: { operation_id: string }): RpcResult<void> {
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

  async reconcile(input: {
    operation_ids: string[];
  }): Promise<RpcResult<void>> {
    return this.ctx.storage.transactionSync(() => {
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

  // Of these operations, those no longer reserved (or never recorded): their
  // index rows can go, since a retry could not be charged twice.
  async settledOperations(input: {
    operation_ids: string[];
  }): Promise<RpcResult<string[]>> {
    const settled: string[] = [];
    for (const operationId of input.operation_ids) {
      const row = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT status FROM quota_operations WHERE operation_id = ?',
          operationId,
        ),
      );
      try {
        if (!row || quotaStatus(text(row, 'status')) !== 'RESERVED')
          settled.push(operationId);
      } catch {
        return failure('corrupt_cache', 'cache quota record is corrupt', 500);
      }
    }
    return ok(settled);
  }

  // Called only after the index shard has forgotten the same operations, so
  // no committed index row is left whose charge a retry could repeat.
  async forgetOperations(input: {
    operation_ids: string[];
  }): Promise<RpcResult<void>> {
    this.ctx.storage.transactionSync(() => {
      for (const operationId of input.operation_ids)
        this.ctx.storage.sql.exec(
          "DELETE FROM quota_operations WHERE operation_id = ? AND status != 'RESERVED'",
          operationId,
        );
    });
    return ok();
  }

  private finalizeRow(
    operationId: string,
    delta: number,
  ): RpcResult<void> | null {
    const cache = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT logical_bytes FROM cache LIMIT 1',
      ),
    );
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
