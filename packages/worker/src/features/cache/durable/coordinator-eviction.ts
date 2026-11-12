import { type RpcResult, failure, ok } from '../../../shared/rpc';
import { first, integer, text, type SqlRow } from '../../../shared/sql';
import { now } from '../../../shared/clock';
import { ensureWorkflow } from '../../../shared/workflows';
import { overHighWatermark } from '../../eviction/policy';
import type { EvictionJob, EvictionResult } from '../../eviction/types';

// A cache still over its watermark after a run that freed nothing (every
// path left is too recent) asks again at most this often.
const RETRY_SECONDS = 60 * 60;
// A run still pending by then is looked at again, and restarted if it failed.
const STALE_SECONDS = 6 * 60 * 60;
const START_RETRY_MS = 60_000;

interface EvictionRow {
  lifecycle: string;
  logical: number;
  quota: number;
  retention_days: number;
  min_age_days: number;
  generation: number;
  pending: boolean;
  requested_at: number;
}

// The coordinator side of eviction: it notices the cache passing its high
// watermark, starts one `EvictCacheWorkflow` run at a time, and keeps the
// last run's result. Runs are numbered by generation, so the workflow
// instance ID is stable across alarm retries and new for each request.
export class CoordinatorEviction {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  // After a reservation is finalized. Costs one row read unless the cache
  // has just crossed its watermark.
  // Never fails the publication that called it: the daily check catches a
  // request missed here.
  async afterGrowth(): Promise<void> {
    try {
      const requested = this.ctx.storage.transactionSync(() => {
        const row = this.row();
        if (
          !row ||
          row.lifecycle !== 'ACTIVE' ||
          row.pending ||
          row.min_age_days === 0 ||
          row.requested_at > now() - RETRY_SECONDS ||
          !overHighWatermark(row.logical, row.quota)
        )
          return false;
        this.request();
        return true;
      });
      if (requested) await this.scheduleAlarm(Date.now());
    } catch (error) {
      console.error('requesting eviction failed', error);
    }
  }

  // The daily check: start a run if the cache has paths to expire or is over
  // its watermark, and restart one that has been pending too long.
  async requestEviction(): Promise<RpcResult<{ requested: boolean }>> {
    let decision: 'none' | 'new' | 'stale';
    try {
      decision = this.ctx.storage.transactionSync(() => {
        const row = this.row();
        if (!row || row.lifecycle !== 'ACTIVE') return 'none';
        if (row.pending)
          return row.requested_at <= now() - STALE_SECONDS ? 'stale' : 'none';
        const quota =
          row.min_age_days > 0 && overHighWatermark(row.logical, row.quota);
        if (!quota && row.retention_days === 0) return 'none';
        this.request();
        return 'new';
      });
    } catch {
      return failure('corrupt_cache', 'cache record is corrupt', 500);
    }
    if (decision === 'none') return ok({ requested: false });
    if (decision === 'stale')
      this.ctx.storage.sql.exec(
        'UPDATE cache SET eviction_requested_at = ?',
        now(),
      );
    await this.scheduleAlarm(Date.now());
    return ok({ requested: true });
  }

  async alarm(): Promise<void> {
    let job: EvictionJob | null;
    try {
      job = this.pendingJob();
    } catch (error) {
      console.error('reading eviction state failed', error);
      return;
    }
    if (!job) return;
    try {
      await ensureWorkflow(
        this.env.EVICT_CACHE,
        `evict-${job.cache.incarnation}-${job.generation}`,
        job,
      );
    } catch (error) {
      console.error('starting eviction failed', error);
      await this.scheduleAlarm(Date.now() + START_RETRY_MS);
    }
  }

  async finished(input: {
    generation: number;
    result: EvictionResult;
  }): Promise<RpcResult<void>> {
    let again: boolean;
    try {
      again = this.ctx.storage.transactionSync(() => {
        const row = this.row();
        if (!row) return false;
        if (row.generation !== input.generation || !row.pending) return false;
        this.ctx.storage.sql.exec(
          'UPDATE cache SET eviction_pending = 0, last_eviction = ?',
          JSON.stringify(input.result),
        );
        // Pushes during the run may have filled the cache again. Only go
        // again straight away if this run made progress.
        if (
          row.lifecycle !== 'ACTIVE' ||
          row.min_age_days === 0 ||
          input.result.evicted_bytes === 0 ||
          !overHighWatermark(row.logical, row.quota)
        )
          return false;
        this.request();
        return true;
      });
    } catch {
      return failure('corrupt_cache', 'cache record is corrupt', 500);
    }
    if (again) await this.scheduleAlarm(Date.now());
    return ok();
  }

  private request(): void {
    this.ctx.storage.sql.exec(
      'UPDATE cache SET eviction_pending = 1, eviction_generation = eviction_generation + 1, eviction_requested_at = ?',
      now(),
    );
  }

  private pendingJob(): EvictionJob | null {
    const row = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT cache_id, name, incarnation, lifecycle, eviction_pending, eviction_generation FROM cache LIMIT 1',
      ),
    );
    if (
      !row ||
      text(row, 'lifecycle') !== 'ACTIVE' ||
      integer(row, 'eviction_pending') !== 1
    )
      return null;
    return {
      cache: {
        id: text(row, 'cache_id'),
        name: text(row, 'name'),
        incarnation: text(row, 'incarnation'),
        coordinator_id: this.ctx.id.toString(),
      },
      generation: integer(row, 'eviction_generation'),
    };
  }

  private row(): EvictionRow | null {
    const row = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT lifecycle, logical_bytes, quota_bytes, retention_days, eviction_min_age_days, eviction_generation, eviction_pending, eviction_requested_at FROM cache LIMIT 1',
      ),
    );
    if (!row) return null;
    return {
      lifecycle: text(row, 'lifecycle'),
      logical: integer(row, 'logical_bytes'),
      quota: integer(row, 'quota_bytes'),
      retention_days: integer(row, 'retention_days'),
      min_age_days: integer(row, 'eviction_min_age_days'),
      generation: integer(row, 'eviction_generation'),
      pending: integer(row, 'eviction_pending') === 1,
      requested_at: integer(row, 'eviction_requested_at'),
    };
  }

  // The coordinator has one alarm, shared with the audit outbox. Never push
  // an earlier alarm later; the alarm handler serves both.
  private async scheduleAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }
}
