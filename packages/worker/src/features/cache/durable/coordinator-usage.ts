import { type RpcResult, failure, ok } from '../../../shared/rpc';
import { first, integer, text, type SqlRow } from '../../../shared/sql';
import { lifecycleFailure } from '../access';
import type { CoordinatorEviction } from './coordinator-eviction';

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export class CoordinatorUsage {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly eviction: CoordinatorEviction,
  ) {}

  async report(input: {
    prefix: string;
    bytes: number;
    revision: number;
  }): Promise<RpcResult<void>> {
    if (
      typeof input.prefix !== 'string' ||
      input.prefix.length === 0 ||
      input.prefix.length > 64 ||
      !validCount(input.bytes) ||
      !validCount(input.revision)
    )
      return failure(
        'invalid_usage',
        'usage must name a shard and non-negative integers',
        400,
      );
    let outcome: { result: RpcResult<void>; grew: boolean };
    try {
      outcome = this.ctx.storage.transactionSync(() => {
        const cache = first(
          this.ctx.storage.sql.exec<SqlRow>(
            'SELECT logical_bytes FROM cache LIMIT 1',
          ),
        );
        if (!cache)
          return {
            result: failure('not_found', 'cache not found', 404),
            grew: false,
          };
        const previous = first(
          this.ctx.storage.sql.exec<SqlRow>(
            'SELECT bytes, revision FROM shard_usage WHERE prefix = ?',
            input.prefix,
          ),
        );
        if (previous && integer(previous, 'revision') >= input.revision)
          return { result: ok(), grew: false };
        const previousBytes = previous ? integer(previous, 'bytes') : 0;
        const logical = integer(cache, 'logical_bytes');
        const next = logical + input.bytes - previousBytes;
        if (!Number.isSafeInteger(next) || next < 0)
          return {
            result: failure(
              'quota_invariant',
              'cache bytes would be out of range',
              409,
            ),
            grew: false,
          };
        this.ctx.storage.sql.exec('UPDATE cache SET logical_bytes = ?', next);
        this.ctx.storage.sql.exec(
          'INSERT OR REPLACE INTO shard_usage (prefix, bytes, revision) VALUES (?, ?, ?)',
          input.prefix,
          input.bytes,
          input.revision,
        );
        return {
          result: ok(),
          grew: input.bytes > previousBytes,
        };
      });
    } catch {
      return failure('corrupt_cache', 'cache usage record is corrupt', 500);
    }
    if (outcome.grew) await this.eviction.afterGrowth();
    return outcome.result;
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
      const logical = integer(cache, 'logical_bytes');
      if (logical + input.delta > quotaBytes)
        return failure('quota_exceeded', 'cache quota exceeded', 409);
      if (logical + input.delta < 0)
        return failure('quota_invariant', 'quota would become negative', 409);
      return ok();
    } catch {
      return failure('corrupt_cache', 'cache quota record is corrupt', 500);
    }
  }
}
