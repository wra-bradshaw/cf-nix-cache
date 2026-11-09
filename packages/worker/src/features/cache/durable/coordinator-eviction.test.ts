/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoordinatorEviction } from './coordinator-eviction';
import { CoordinatorQuota, QUOTA_RESERVED_INDEX } from './quota';
import type { EvictionResult } from '../../eviction/types';
import type { RpcResult } from '../../../shared/rpc';

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW_MS = 1_000_000_000;
const NOW = Math.floor(NOW_MS / 1000);

function now(): void {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
}

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

interface CacheRow {
  lifecycle: string;
  logical_bytes: number;
  quota_bytes: number;
  retention_days: number;
  eviction_min_age_days: number;
  eviction_generation: number;
  eviction_pending: number;
  eviction_requested_at: number;
}

const DEFAULT_ROW: CacheRow = {
  lifecycle: 'ACTIVE',
  logical_bytes: 0,
  quota_bytes: 100,
  retention_days: 0,
  eviction_min_age_days: 30,
  eviction_generation: 0,
  eviction_pending: 0,
  eviction_requested_at: 0,
};

interface WorkflowFake {
  calls: { id: string; params: unknown }[];
  createBatch: (input: {
    instances: { id: string; params: unknown }[];
  }) => Promise<{ created: unknown[]; errors: { message: string }[] }>;
  get: (id: string) => Promise<{
    status: () => Promise<{ status: string }>;
    restart: () => Promise<void>;
  }>;
  restarts: number;
}

function workflowFake(): WorkflowFake {
  const fake: WorkflowFake = {
    calls: [],
    restarts: 0,
    createBatch: async (input) => {
      for (const instance of input.instances)
        fake.calls.push({ id: instance.id, params: instance.params });
      return { created: [], errors: [] };
    },
    get: async () => ({
      status: async () => ({ status: 'running' }),
      restart: async () => {
        fake.restarts += 1;
      },
    }),
  };
  return fake;
}

function setup(
  row: Partial<CacheRow> | null = {},
  workflow: WorkflowFake = workflowFake(),
): {
  db: DatabaseSync;
  eviction: CoordinatorEviction;
  workflow: WorkflowFake;
  alarms: number[];
  alarm: () => number | null;
  setAlarm: (at: number | null) => void;
} {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE cache (
    cache_id TEXT PRIMARY KEY, name TEXT NOT NULL, incarnation TEXT NOT NULL,
    lifecycle TEXT NOT NULL, logical_bytes INTEGER NOT NULL DEFAULT 0,
    quota_bytes INTEGER NOT NULL DEFAULT 0,
    retention_days INTEGER NOT NULL DEFAULT 0,
    eviction_min_age_days INTEGER NOT NULL DEFAULT 30,
    eviction_generation INTEGER NOT NULL DEFAULT 0,
    eviction_pending INTEGER NOT NULL DEFAULT 0,
    eviction_requested_at INTEGER NOT NULL DEFAULT 0,
    last_eviction TEXT
  );`);
  if (row) {
    const full = { ...DEFAULT_ROW, ...row };
    db.prepare(
      'INSERT INTO cache (cache_id, name, incarnation, lifecycle, logical_bytes, quota_bytes, retention_days, eviction_min_age_days, eviction_generation, eviction_pending, eviction_requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'cache-id',
      'cache',
      'cache-inc',
      full.lifecycle,
      full.logical_bytes,
      full.quota_bytes,
      full.retention_days,
      full.eviction_min_age_days,
      full.eviction_generation,
      full.eviction_pending,
      full.eviction_requested_at,
    );
  }
  let alarm: number | null = null;
  const alarms: number[] = [];
  const exec = (query: string, ...args: unknown[]) => {
    const verb = query.trimStart().split(/\s+/)[0]!.toUpperCase();
    if (
      args.length > 0 ||
      verb === 'SELECT' ||
      verb === 'PRAGMA' ||
      verb === 'WITH'
    )
      return db.prepare(query).all(...(args as string[]));
    db.exec(query);
    return [];
  };
  const ctx = {
    id: { toString: () => 'coordinator-id' },
    storage: {
      sql: { exec },
      transactionSync: <T>(body: () => T): T => {
        db.exec('BEGIN');
        try {
          const result = body();
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => {
        alarms.push(at);
        alarm = at;
      },
    },
  } as unknown as DurableObjectState;
  const env = { EVICT_CACHE: workflow } as unknown as Env;
  return {
    db,
    eviction: new CoordinatorEviction(ctx, env),
    workflow,
    alarms,
    alarm: () => alarm,
    setAlarm: (at) => {
      alarm = at;
    },
  };
}

interface EvictionState {
  eviction_generation: number;
  eviction_pending: number;
  eviction_requested_at: number;
  last_eviction: string | null;
}

function state(db: DatabaseSync): EvictionState {
  return db
    .prepare(
      'SELECT eviction_generation, eviction_pending, eviction_requested_at, last_eviction FROM cache LIMIT 1',
    )
    .get() as unknown as EvictionState;
}

function evictionResult(
  overrides: Partial<EvictionResult> = {},
): EvictionResult {
  return {
    run_id: 'run',
    started_at: NOW,
    finished_at: NOW + 1,
    target_bytes: 15,
    cutoff: NOW - 100,
    evicted_paths: 2,
    evicted_bytes: 100,
    skipped_paths: 0,
    floor_reached: false,
    ...overrides,
  };
}

describe('triggering on growth', () => {
  it('starts a run when the cache crosses ninety percent', async () => {
    now();
    const { db, eviction, alarms } = setup({ logical_bytes: 91 });
    await eviction.afterGrowth();
    expect(state(db)).toMatchObject({
      eviction_generation: 1,
      eviction_pending: 1,
      eviction_requested_at: NOW,
    });
    expect(alarms).toEqual([NOW_MS]);
  });

  it('schedules the alarm exactly once while the run is pending', async () => {
    now();
    const { eviction, alarms } = setup({ logical_bytes: 91 });
    await eviction.afterGrowth();
    await eviction.afterGrowth();
    expect(alarms).toEqual([NOW_MS]);
  });

  it('stays quiet below the watermark', async () => {
    now();
    const { db, eviction, alarms } = setup({ logical_bytes: 90 });
    await eviction.afterGrowth();
    expect(state(db)).toMatchObject({
      eviction_generation: 0,
      eviction_pending: 0,
    });
    expect(alarms).toEqual([]);
  });

  it('stays quiet when the minimum age is zero', async () => {
    now();
    const { db, eviction, alarms } = setup({
      logical_bytes: 91,
      eviction_min_age_days: 0,
    });
    await eviction.afterGrowth();
    expect(state(db)).toMatchObject({ eviction_pending: 0 });
    expect(alarms).toEqual([]);
  });

  it('stays quiet while a run is pending', async () => {
    now();
    const { db, eviction, alarms } = setup({
      logical_bytes: 91,
      eviction_generation: 5,
      eviction_pending: 1,
    });
    await eviction.afterGrowth();
    expect(state(db)).toMatchObject({
      eviction_generation: 5,
      eviction_pending: 1,
    });
    expect(alarms).toEqual([]);
  });

  it('stays quiet within an hour of the last request', async () => {
    now();
    const { db, eviction, alarms } = setup({
      logical_bytes: 91,
      eviction_requested_at: NOW - 10,
    });
    await eviction.afterGrowth();
    expect(state(db)).toMatchObject({ eviction_pending: 0 });
    expect(alarms).toEqual([]);
  });

  it('asks again an hour after the last request', async () => {
    now();
    const { db, eviction, alarms } = setup({
      logical_bytes: 91,
      eviction_requested_at: NOW - 3601,
    });
    await eviction.afterGrowth();
    expect(state(db)).toMatchObject({
      eviction_generation: 1,
      eviction_pending: 1,
    });
    expect(alarms).toEqual([NOW_MS]);
  });
});

describe('the daily request', () => {
  it('starts a retention run under the watermark', async () => {
    now();
    const { db, eviction } = setup({ logical_bytes: 50, retention_days: 30 });
    await expect(eviction.requestEviction()).resolves.toMatchObject({
      ok: true,
      value: { requested: true },
    });
    expect(state(db)).toMatchObject({
      eviction_generation: 1,
      eviction_pending: 1,
    });
  });

  it('starts a quota run under no retention', async () => {
    now();
    const { eviction } = setup({ logical_bytes: 91, retention_days: 0 });
    await expect(eviction.requestEviction()).resolves.toMatchObject({
      ok: true,
      value: { requested: true },
    });
  });

  it('stays quiet with room in quota and no retention', async () => {
    now();
    const { db, eviction } = setup({ logical_bytes: 50, retention_days: 0 });
    await expect(eviction.requestEviction()).resolves.toMatchObject({
      ok: true,
      value: { requested: false },
    });
    expect(state(db)).toMatchObject({ eviction_pending: 0 });
  });

  it('leaves a recent pending run alone', async () => {
    now();
    const { db, eviction, alarms } = setup({
      eviction_pending: 1,
      eviction_generation: 6,
      eviction_requested_at: NOW - 10,
    });
    await expect(eviction.requestEviction()).resolves.toMatchObject({
      ok: true,
      value: { requested: false },
    });
    expect(state(db)).toMatchObject({ eviction_generation: 6 });
    expect(alarms).toEqual([]);
  });

  it('restarts a run pending for over six hours without bumping the generation', async () => {
    now();
    const { db, eviction, alarms } = setup({
      eviction_pending: 1,
      eviction_generation: 6,
      eviction_requested_at: NOW - 7 * 3600,
    });
    await expect(eviction.requestEviction()).resolves.toMatchObject({
      ok: true,
      value: { requested: true },
    });
    expect(state(db)).toMatchObject({
      eviction_generation: 6,
      eviction_pending: 1,
      eviction_requested_at: NOW,
    });
    expect(alarms).toEqual([NOW_MS]);
  });

  it('ignores a cache that is being deleted', async () => {
    now();
    const { eviction } = setup({
      lifecycle: 'DELETING',
      logical_bytes: 91,
      retention_days: 30,
    });
    await expect(eviction.requestEviction()).resolves.toMatchObject({
      ok: true,
      value: { requested: false },
    });
  });

  it('ignores a cache row that is gone', async () => {
    now();
    const { eviction } = setup(null);
    await expect(eviction.requestEviction()).resolves.toMatchObject({
      ok: true,
      value: { requested: false },
    });
  });
});

describe('the eviction alarm', () => {
  it('starts the pending workflow', async () => {
    now();
    const { eviction, workflow } = setup({
      eviction_pending: 1,
      eviction_generation: 4,
    });
    await eviction.alarm();
    expect(workflow.calls).toHaveLength(1);
    expect(workflow.calls[0]!.id).toBe('evict-cache-inc-4');
    expect(workflow.calls[0]!.params).toEqual({
      cache: {
        id: 'cache-id',
        name: 'cache',
        incarnation: 'cache-inc',
        coordinator_id: 'coordinator-id',
      },
      generation: 4,
    });
  });

  it('does nothing without a pending run', async () => {
    now();
    const { eviction, workflow } = setup({ eviction_pending: 0 });
    await eviction.alarm();
    expect(workflow.calls).toEqual([]);
  });

  it('retries the alarm when starting the workflow fails', async () => {
    now();
    const failing = workflowFake();
    failing.createBatch = async () => {
      throw new Error('workflow down');
    };
    failing.get = async () => {
      throw new Error('lookup down');
    };
    const { eviction, alarm } = setup(
      { eviction_pending: 1, eviction_generation: 2 },
      failing,
    );
    await eviction.alarm();
    expect(alarm()).toBe(NOW_MS + 60_000);
  });

  it('never moves an earlier alarm later', async () => {
    now();
    const { db, eviction, alarms, alarm, setAlarm } = setup({
      logical_bytes: 91,
    });
    await eviction.afterGrowth();
    expect(alarm()).toBe(NOW_MS);
    // The audit outbox holds an earlier alarm; eviction must not push it out.
    setAlarm(NOW_MS - 5000);
    db.exec('UPDATE cache SET eviction_pending = 0, eviction_requested_at = 0');
    await eviction.afterGrowth();
    expect(alarm()).toBe(NOW_MS - 5000);
    expect(alarms).toEqual([NOW_MS]);
  });
});

describe('finishing a run', () => {
  it('ignores a finish for the wrong generation', async () => {
    now();
    const { db, eviction, alarms } = setup({
      eviction_pending: 1,
      eviction_generation: 6,
    });
    await expect(
      eviction.finished({ generation: 5, result: evictionResult() }),
    ).resolves.toMatchObject({ ok: true });
    expect(state(db)).toMatchObject({
      eviction_pending: 1,
      eviction_generation: 6,
      last_eviction: null,
    });
    expect(alarms).toEqual([]);
  });

  it('ignores a finish when nothing is pending', async () => {
    now();
    const { db, eviction } = setup({
      eviction_pending: 0,
      eviction_generation: 6,
    });
    await expect(
      eviction.finished({ generation: 6, result: evictionResult() }),
    ).resolves.toMatchObject({ ok: true });
    expect(state(db)).toMatchObject({
      eviction_pending: 0,
      last_eviction: null,
    });
  });

  it('clears the run and stores the result', async () => {
    now();
    const { db, eviction, alarms } = setup({
      logical_bytes: 50,
      eviction_pending: 1,
      eviction_generation: 6,
    });
    const result = evictionResult();
    await expect(
      eviction.finished({ generation: 6, result }),
    ).resolves.toMatchObject({ ok: true });
    const row = state(db);
    expect(row).toMatchObject({ eviction_pending: 0, eviction_generation: 6 });
    expect(JSON.parse(row.last_eviction!)).toEqual(result);
    expect(alarms).toEqual([]);
  });

  it('requests again while still over the watermark after freeing bytes', async () => {
    now();
    const { db, eviction, alarms } = setup({
      logical_bytes: 95,
      eviction_pending: 1,
      eviction_generation: 6,
    });
    await expect(
      eviction.finished({ generation: 6, result: evictionResult() }),
    ).resolves.toMatchObject({ ok: true });
    expect(state(db)).toMatchObject({
      eviction_pending: 1,
      eviction_generation: 7,
      eviction_requested_at: NOW,
    });
    expect(alarms).toEqual([NOW_MS]);
  });

  it('does not request again when the run freed nothing', async () => {
    now();
    const { db, eviction, alarms } = setup({
      logical_bytes: 95,
      eviction_pending: 1,
      eviction_generation: 6,
    });
    await expect(
      eviction.finished({
        generation: 6,
        result: evictionResult({ evicted_bytes: 0, evicted_paths: 0 }),
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(state(db)).toMatchObject({
      eviction_pending: 0,
      eviction_generation: 6,
    });
    expect(alarms).toEqual([]);
  });

  it('does not request again when back under the watermark', async () => {
    now();
    const { db, eviction, alarms } = setup({
      logical_bytes: 50,
      eviction_pending: 1,
      eviction_generation: 6,
    });
    await expect(
      eviction.finished({ generation: 6, result: evictionResult() }),
    ).resolves.toMatchObject({ ok: true });
    expect(state(db)).toMatchObject({
      eviction_pending: 0,
      eviction_generation: 6,
    });
    expect(alarms).toEqual([]);
  });
});

function quotaSetup(): {
  db: DatabaseSync;
  quota: CoordinatorQuota;
  afterGrowth: ReturnType<typeof vi.fn>;
} {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE cache (
    lifecycle TEXT NOT NULL, logical_bytes INTEGER NOT NULL DEFAULT 0,
    quota_bytes INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO cache VALUES ('ACTIVE', 0, 100);
  CREATE TABLE quota_operations (
    operation_id TEXT PRIMARY KEY, delta INTEGER NOT NULL, status TEXT NOT NULL
  );
  ${QUOTA_RESERVED_INDEX}`);
  const exec = (query: string, ...args: unknown[]) => {
    const verb = query.trimStart().split(/\s+/)[0]!.toUpperCase();
    if (
      args.length > 0 ||
      verb === 'SELECT' ||
      verb === 'PRAGMA' ||
      verb === 'WITH'
    )
      return db.prepare(query).all(...(args as string[]));
    db.exec(query);
    return [];
  };
  const ctx = {
    storage: {
      sql: { exec },
      transactionSync: <T>(body: () => T): T => {
        db.exec('BEGIN');
        try {
          const result = body();
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    },
  } as unknown as DurableObjectState;
  const afterGrowth = vi.fn(async () => undefined);
  const quota = new CoordinatorQuota(ctx, {
    afterGrowth,
  } as unknown as CoordinatorEviction);
  return { db, quota, afterGrowth };
}

describe('pruning quota operations', () => {
  it('settles every operation that is no longer reserved', async () => {
    const { quota } = quotaSetup();
    value(await quota.reserve({ operation_id: 'reserved', delta: 10 }));
    value(await quota.reserve({ operation_id: 'finalized', delta: 10 }));
    value(await quota.finalize({ operation_id: 'finalized' }));
    value(await quota.reserve({ operation_id: 'aborted', delta: 10 }));
    value(await quota.abort({ operation_id: 'aborted' }));

    await expect(
      quota.settledOperations({
        operation_ids: ['reserved', 'finalized', 'aborted', 'missing'],
      }),
    ).resolves.toEqual({
      ok: true,
      value: ['finalized', 'aborted', 'missing'],
    });
  });

  it('forgets settled operations but keeps reserved ones', async () => {
    const { db, quota } = quotaSetup();
    value(await quota.reserve({ operation_id: 'reserved', delta: 10 }));
    value(await quota.reserve({ operation_id: 'finalized', delta: 10 }));
    value(await quota.finalize({ operation_id: 'finalized' }));

    value(
      await quota.forgetOperations({
        operation_ids: ['reserved', 'finalized'],
      }),
    );

    const remaining = db
      .prepare('SELECT operation_id AS id, status FROM quota_operations')
      .all() as { id: string; status: string }[];
    expect(remaining).toEqual([{ id: 'reserved', status: 'RESERVED' }]);
  });

  it('ignores finalized, aborted and negative deltas in the pending sum', async () => {
    const { quota } = quotaSetup();
    // A finalized reservation is settled bytes, not pending.
    value(await quota.reserve({ operation_id: 'f', delta: 60 }));
    value(await quota.finalize({ operation_id: 'f' }));
    // 60 settled + 40 pending fits in 100 only if the 60 is not pending too.
    await expect(
      quota.reserve({ operation_id: 'g', delta: 40 }),
    ).resolves.toMatchObject({ ok: true });
    // An aborted reservation holds nothing back.
    value(await quota.abort({ operation_id: 'g' }));
    await expect(
      quota.reserve({ operation_id: 'h', delta: 40 }),
    ).resolves.toMatchObject({ ok: true });
    // A negative reservation frees bytes; it never offsets pending growth.
    value(await quota.finalize({ operation_id: 'h' }));
    value(await quota.reserve({ operation_id: 'n', delta: -10 }));
    await expect(
      quota.reserve({ operation_id: 'i', delta: 5 }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'quota_exceeded' },
    });
  });

  it('notifies eviction after finalizing growth', async () => {
    const { quota, afterGrowth } = quotaSetup();
    value(await quota.reserve({ operation_id: 'op', delta: 10 }));
    value(await quota.finalize({ operation_id: 'op' }));
    expect(afterGrowth).toHaveBeenCalledOnce();
  });
});
