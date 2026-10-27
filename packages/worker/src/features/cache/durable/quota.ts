import type { QuotaReservation } from '../../../types';
import type { RpcResult } from '../../../rpc';
import { failure, first, ok } from '../../../infrastructure/durable/shared';
import { lifecycleFailure } from '../../domain/errors';

export class CoordinatorQuota {
  constructor(private readonly ctx: DurableObjectState) {}

  async reserve(input: {
    operation_id: string;
    delta: number;
  }): Promise<RpcResult<QuotaReservation>> {
    return this.ctx.storage.transactionSync(() => {
      // Reconcile an operation before checking lifecycle. A publication may
      // have committed its index mutation immediately before deletion fenced
      // the cache, and must still be allowed to finalize its already-created
      // reservation so the deletion workflow can make progress.
      const old = first(
        this.ctx.storage.sql.exec<{
          delta: number;
          status: QuotaReservation['status'];
        }>(
          'SELECT delta, status FROM quota_operations WHERE operation_id = ?',
          input.operation_id,
        ),
      );
      if (old) {
        if (Number(old.delta) !== input.delta)
          return failure(
            'operation_conflict',
            'operation delta changed during retry',
            409,
          );
        return ok({
          operation_id: input.operation_id,
          delta: input.delta,
          status: old.status,
        });
      }
      const cache = first(
        this.ctx.storage.sql.exec<{
          lifecycle: string;
          logical_bytes: number;
          quota_bytes: number;
        }>('SELECT lifecycle, logical_bytes, quota_bytes FROM cache LIMIT 1'),
      );
      if (!cache) return failure('not_found', 'cache not found', 404);
      const blocked = lifecycleFailure(cache.lifecycle);
      if (blocked)
        return failure(blocked.code, blocked.message, blocked.status);
      const pending =
        first(
          this.ctx.storage.sql.exec<{ value: number }>(
            "SELECT COALESCE(SUM(CASE WHEN status = 'RESERVED' AND delta > 0 THEN delta ELSE 0 END), 0) AS value FROM quota_operations",
          ),
        )?.value ?? 0;
      if (
        !Number.isSafeInteger(input.delta) ||
        Number(cache.logical_bytes) + Number(pending) + input.delta >
          Number(cache.quota_bytes)
      )
        return failure('quota_exceeded', 'cache quota exceeded', 409);
      if (Number(cache.logical_bytes) + input.delta < 0)
        return failure('quota_invariant', 'quota would become negative', 409);
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

  async finalize(input: { operation_id: string }): Promise<RpcResult<void>> {
    return this.ctx.storage.transactionSync(() => {
      const row = first(
        this.ctx.storage.sql.exec<{ delta: number; status: string }>(
          'SELECT delta, status FROM quota_operations WHERE operation_id = ?',
          input.operation_id,
        ),
      );
      if (!row)
        return failure('operation_not_found', 'quota operation not found', 404);
      if (row.status === 'FINALIZED') return ok();
      if (row.status === 'ABORTED')
        return failure('operation_aborted', 'quota operation was aborted', 409);
      this.finalizeRow(input.operation_id, Number(row.delta));
      return ok();
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
      for (const operationId of input.operation_ids) {
        const row = first(
          this.ctx.storage.sql.exec<{
            delta: number;
            status: QuotaReservation['status'];
          }>(
            'SELECT delta, status FROM quota_operations WHERE operation_id = ?',
            operationId,
          ),
        );
        if (row?.status === 'RESERVED')
          this.finalizeRow(operationId, Number(row.delta));
      }
      return ok();
    });
  }

  /** Applies a RESERVED operation's delta and marks it FINALIZED. */
  private finalizeRow(operationId: string, delta: number): void {
    this.ctx.storage.sql.exec(
      'UPDATE cache SET logical_bytes = logical_bytes + ?',
      delta,
    );
    this.ctx.storage.sql.exec(
      "UPDATE quota_operations SET status = 'FINALIZED' WHERE operation_id = ? AND status = 'RESERVED'",
      operationId,
    );
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
        this.ctx.storage.sql.exec<{ delta: number }>(
          'SELECT delta FROM clear_operations WHERE operation_id = ?',
          input.operation_id,
        ),
      );
      if (old)
        return Number(old.delta) === input.delta
          ? ok()
          : failure(
              'operation_conflict',
              'clear operation delta changed during retry',
              409,
            );
      const cache = first(
        this.ctx.storage.sql.exec<{ logical_bytes: number }>(
          'SELECT logical_bytes FROM cache LIMIT 1',
        ),
      );
      if (!cache || Number(cache.logical_bytes) + input.delta < 0)
        return failure(
          'quota_invariant',
          'cache bytes would become negative',
          409,
        );
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
