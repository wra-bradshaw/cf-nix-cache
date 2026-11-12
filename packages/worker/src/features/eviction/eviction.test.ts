import { describe, expect, it } from 'vitest';
import { shardPrefixes } from '../cache/shards';
import type { CacheConfig } from '../cache/types';
import { DAY_SECONDS, HOUR_SECONDS } from './policy';
import { runEviction } from './eviction';
import type { EvictionPorts, EvictionSteps } from './eviction-ports';
import type {
  EvictionCacheRef,
  EvictionJob,
  EvictionResult,
  ListedCache,
} from './types';

const NOW = 1_000_000;
const OLD = NOW - 30 * DAY_SECONDS;
const HASH = (prefix: string) => prefix.padEnd(32, '0');

interface StoredPath {
  hash: string;
  last: number;
  size: number;
}

function cacheRef(
  name = 'cache',
  lifecycle: ListedCache['lifecycle'] = 'ACTIVE',
): ListedCache {
  return {
    id: `${name}-id`,
    name,
    incarnation: `${name}-inc`,
    coordinator_id: `${name}-coordinator`,
    lifecycle,
  };
}

function config(overrides: Partial<CacheConfig> = {}): CacheConfig {
  return {
    id: 'cache-id',
    name: 'cache',
    public: true,
    quota_bytes: 10_000,
    logical_bytes: 0,
    encoding_id: 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1',
    created_at: 1,
    lifecycle: 'ACTIVE',
    retention_days: 0,
    eviction_min_age_days: 30,
    last_eviction: null,
    upstream_cache_key_names: [],
    ...overrides,
  };
}

class World {
  readonly paths = new Map<string, StoredPath>();
  readonly busy = new Set<string>();
  readonly evictCalls: { hash: string; before: number }[] = [];
  readonly requested: EvictionCacheRef[] = [];
  readonly finishedCalls: {
    cache: EvictionCacheRef;
    generation: number;
    result: EvictionResult;
  }[] = [];
  readonly audits: EvictionResult[] = [];
  readonly histogramBefores: number[] = [];
  readonly refreshed = new Map<string, string[]>();
  readonly events: string[] = [];
  live: ListedCache[] = [];
  cacheConfig: CacheConfig | null = config();
  refuseRequest = false;

  ports(): EvictionPorts {
    return {
      liveCaches: async () => this.live,
      refreshUsage: async (cache, prefixes) => {
        const shards = this.refreshed.get(cache.incarnation) ?? [];
        shards.push(...prefixes);
        this.refreshed.set(cache.incarnation, shards);
        for (const prefix of prefixes)
          this.events.push(`refresh ${cache.incarnation} ${prefix}`);
      },
      requestEviction: async (cache) => {
        this.events.push(`request ${cache.incarnation}`);
        this.requested.push(cache);
        return !this.refuseRequest;
      },
      cacheConfig: async () => this.cacheConfig,
      accessHistogram: async (_cache, prefix, before) => {
        this.histogramBefores.push(before);
        const byHour = new Map<number, number>();
        for (const path of this.paths.values()) {
          if (!path.hash.startsWith(prefix) || path.last >= before) continue;
          const hour = Math.floor(path.last / HOUR_SECONDS);
          byHour.set(hour, (byHour.get(hour) ?? 0) + path.size);
        }
        return [...byHour];
      },
      expiredPaths: async (_cache, prefix, before, after, limit) => {
        const matching = [...this.paths.values()]
          .filter(
            (path) =>
              path.hash.startsWith(prefix) &&
              path.last < before &&
              path.hash > (after ?? ''),
          )
          .map((path) => path.hash)
          .sort();
        const hashes = matching.slice(0, limit);
        return {
          hashes,
          next_after: matching.length > limit ? hashes.at(-1)! : null,
        };
      },
      evict: async (_cache, _config, hash, before) => {
        this.evictCalls.push({ hash, before });
        if (this.busy.has(hash)) return null;
        const path = this.paths.get(hash);
        if (!path) return null;
        this.paths.delete(hash);
        return path.size;
      },
      finished: async (cache, generation, result) => {
        this.finishedCalls.push({ cache, generation, result });
      },
      audit: async (_cache, result) => {
        this.audits.push(result);
      },
    };
  }

  steps(): EvictionSteps {
    return { do: async (_name, body) => body() };
  }

  run(job: EvictionJob | null, run_id = 'run') {
    return runEviction(
      { run_id, now: NOW, job },
      this.ports(),
      this.steps(),
      () => NOW + 1,
    );
  }

  job(generation = 3): EvictionJob {
    const cache = cacheRef();
    this.live = [cache];
    return { cache, generation };
  }

  store(hash: string, last: number, size = 10): void {
    this.paths.set(hash, { hash, last, size });
  }
}

function resultOf(
  result: EvictionResult | { requested: number },
): EvictionResult {
  expect(result).not.toHaveProperty('requested');
  return result as EvictionResult;
}

describe('retention', () => {
  it('evicts only expired paths, passing the cutoff as unused_before', async () => {
    const world = new World();
    world.cacheConfig = config({ retention_days: 7, eviction_min_age_days: 0 });
    world.store(HASH('aa'), OLD);
    world.store(HASH('bb'), NOW);

    const result = resultOf(await world.run(world.job()));

    expect([...world.paths.keys()]).toEqual([HASH('bb')]);
    expect(result).toMatchObject({
      evicted_paths: 1,
      cutoff: NOW - 7 * DAY_SECONDS,
    });
    expect(world.evictCalls).toEqual([
      { hash: HASH('aa'), before: NOW - 7 * DAY_SECONDS },
    ]);
    expect(world.audits).toHaveLength(1);
  });

  it('leaves a cache without retention alone', async () => {
    const world = new World();
    world.cacheConfig = config({ retention_days: 0, eviction_min_age_days: 0 });
    world.store(HASH('aa'), OLD);

    const result = resultOf(await world.run(world.job()));

    expect(world.paths.size).toBe(1);
    expect(result).toMatchObject({ evicted_paths: 0, cutoff: null });
    expect(world.evictCalls).toEqual([]);
    expect(world.audits).toEqual([]);
    expect(world.finishedCalls).toHaveLength(1);
  });
});

describe('retention at scale', () => {
  const PATHS = 1203;
  const expiredInOneShard = (world: World): string[] => {
    const hashes = Array.from(
      { length: PATHS },
      (_, index) => `ab${String(index).padStart(30, '0')}`,
    );
    for (const hash of hashes) world.store(hash, OLD);
    return hashes;
  };

  const retention = (world: World) => {
    world.cacheConfig = config({ retention_days: 7, eviction_min_age_days: 0 });
  };

  it('evicts every expired path in a shard over several pages', async () => {
    const world = new World();
    retention(world);
    expiredInOneShard(world);

    const result = resultOf(await world.run(world.job()));

    expect(world.paths.size).toBe(0);
    expect(result).toMatchObject({ evicted_paths: PATHS });
    expect(world.audits).toHaveLength(1);
  });

  it('skips busy paths rather than retrying them forever', async () => {
    const world = new World();
    retention(world);
    const hashes = expiredInOneShard(world);
    for (const hash of hashes.slice(0, 600)) world.busy.add(hash);

    const result = resultOf(await world.run(world.job()));

    expect(result).toMatchObject({
      evicted_paths: PATHS - 600,
      skipped_paths: 600,
    });
    expect(world.paths.size).toBe(600);
  });

  it('reaches every shard when some need several pages', async () => {
    const world = new World();
    retention(world);
    for (const prefix of shardPrefixes()) world.store(HASH(prefix), OLD);
    for (let index = 0; index < 1100; index += 1)
      world.store(`00${String(index + 1).padStart(30, '0')}`, OLD);

    const result = resultOf(await world.run(world.job()));

    expect(result).toMatchObject({ evicted_paths: 1024 + 1100 });
    expect(world.paths.size).toBe(0);
  });
});

describe('quota eviction', () => {
  const floor = NOW - 30 * DAY_SECONDS;

  function overQuota(world: World): void {
    world.cacheConfig = config({
      retention_days: 0,
      eviction_min_age_days: 30,
      quota_bytes: 1000,
      logical_bytes: 950,
    });
  }

  it('uses the quota cutoff from the access histogram', async () => {
    const world = new World();
    overQuota(world);
    world.store('aa00', floor - 3 * DAY_SECONDS, 100);
    world.store('bb00', floor - 2 * DAY_SECONDS, 100);
    world.store('cc00', floor - 1 * DAY_SECONDS, 100);
    world.store('dd00', NOW, 100);
    const expectedCutoff =
      (Math.floor((floor - 2 * DAY_SECONDS) / HOUR_SECONDS) + 1) * HOUR_SECONDS;

    const result = resultOf(await world.run(world.job()));

    expect(world.histogramBefores).not.toEqual([]);
    expect(world.histogramBefores.every((before) => before === floor)).toBe(
      true,
    );
    // Target is 950 - 800 = 150, so the two oldest hundred-byte paths go.
    expect(result).toMatchObject({
      target_bytes: 150,
      cutoff: expectedCutoff,
      evicted_paths: 2,
      evicted_bytes: 200,
      floor_reached: false,
    });
    expect([...world.paths.keys()].sort()).toEqual(['cc00', 'dd00']);
  });

  it('lets the later retention cutoff win over quota', async () => {
    const world = new World();
    world.cacheConfig = config({
      retention_days: 7,
      eviction_min_age_days: 30,
      quota_bytes: 1000,
      logical_bytes: 950,
    });
    // Expired by retention only: the quota cutoff sits near floor - 9 days.
    world.store(HASH('aa'), floor - 10 * DAY_SECONDS, 100);
    world.store(HASH('bb'), floor - 9 * DAY_SECONDS, 100);
    world.store(HASH('cc'), NOW - 8 * DAY_SECONDS, 100);
    world.store(HASH('dd'), NOW - 1 * DAY_SECONDS, 100);

    const result = resultOf(await world.run(world.job()));

    expect(result.cutoff).toBe(NOW - 7 * DAY_SECONDS);
    expect([...world.paths.keys()].sort()).toEqual([HASH('dd')]);
    expect(
      world.evictCalls.every(({ before }) => before === NOW - 7 * DAY_SECONDS),
    ).toBe(true);
  });

  it('lets the later quota cutoff win over retention', async () => {
    const world = new World();
    world.cacheConfig = config({
      retention_days: 60,
      eviction_min_age_days: 30,
      quota_bytes: 1000,
      logical_bytes: 950,
    });
    world.store(HASH('aa'), floor - 10 * DAY_SECONDS, 100);
    world.store(HASH('bb'), floor - 9 * DAY_SECONDS, 100);
    // Older than the quota cutoff but newer than the retention cutoff.
    world.store(HASH('cc'), NOW - 50 * DAY_SECONDS, 100);
    world.store(HASH('dd'), NOW - 1 * DAY_SECONDS, 100);
    // The histogram also sees cc, so the 150-byte target is met at aa's hour.
    const expectedCutoff =
      (Math.floor((floor - 10 * DAY_SECONDS) / HOUR_SECONDS) + 1) *
      HOUR_SECONDS;

    const result = resultOf(await world.run(world.job()));

    expect(result.cutoff).toBe(expectedCutoff);
    // cc is expired by quota only; bb is expired by neither, dd by neither.
    expect([...world.paths.keys()].sort()).toEqual([HASH('bb'), HASH('dd')]);
  });
});

describe('finishing a run', () => {
  it('ends a deleted cache without calling finished', async () => {
    const world = new World();
    world.cacheConfig = null;
    world.store(HASH('aa'), OLD);

    const result = resultOf(await world.run(world.job()));

    expect(result).toMatchObject({
      evicted_paths: 0,
      cutoff: null,
      target_bytes: 0,
    });
    expect(world.finishedCalls).toEqual([]);
    expect(world.audits).toEqual([]);
    expect(world.paths.size).toBe(1);
  });

  it('ends a cache that is no longer active without calling finished', async () => {
    const world = new World();
    world.cacheConfig = config({
      retention_days: 7,
      eviction_min_age_days: 0,
      lifecycle: 'DELETING',
    });
    world.store(HASH('aa'), OLD);

    await world.run(world.job());

    expect(world.finishedCalls).toEqual([]);
    expect(world.paths.size).toBe(1);
  });

  it('reports the generation and totals to finished', async () => {
    const world = new World();
    world.cacheConfig = config({ retention_days: 7, eviction_min_age_days: 0 });
    world.store(HASH('aa'), OLD, 40);
    world.store(HASH('bb'), NOW, 50);
    const job = world.job(7);

    const result = resultOf(await world.run(job));

    expect(world.finishedCalls).toEqual([
      { cache: job.cache, generation: 7, result },
    ]);
    expect(result).toMatchObject({
      run_id: 'run',
      started_at: NOW,
      finished_at: NOW + 1,
      evicted_paths: 1,
      evicted_bytes: 40,
      skipped_paths: 0,
    });
  });

  it('audits only when something was evicted', async () => {
    const withEviction = new World();
    withEviction.cacheConfig = config({
      retention_days: 7,
      eviction_min_age_days: 0,
    });
    withEviction.store(HASH('aa'), OLD);
    const evicted = resultOf(await withEviction.run(withEviction.job()));
    expect(withEviction.audits).toEqual([evicted]);

    const withoutEviction = new World();
    withoutEviction.cacheConfig = config({
      retention_days: 7,
      eviction_min_age_days: 0,
    });
    withoutEviction.store(HASH('aa'), NOW);
    const kept = resultOf(await withoutEviction.run(withoutEviction.job()));
    expect(kept).toMatchObject({ evicted_paths: 0 });
    expect(withoutEviction.audits).toEqual([]);
    expect(withoutEviction.finishedCalls).toHaveLength(1);
  });
});

describe('the scheduled run', () => {
  it('refreshes every shard before asking for eviction', async () => {
    const world = new World();
    const first = cacheRef('first');
    const second = cacheRef('second');
    world.live = [first, second];

    await world.run(null);

    for (const cache of [first, second]) {
      expect(world.refreshed.get(cache.incarnation)).toEqual(shardPrefixes());
      const request = world.events.indexOf(`request ${cache.incarnation}`);
      const refreshIndexes = world.events
        .map((event, index) =>
          event.startsWith(`refresh ${cache.incarnation} `) ? index : -1,
        )
        .filter((index) => index >= 0);
      expect(refreshIndexes.length).toBe(shardPrefixes().length);
      expect(request).toBeGreaterThan(refreshIndexes.at(-1)!);
    }
  });

  it('skips caches that are not active', async () => {
    const world = new World();
    const active = cacheRef('active');
    const deleting = cacheRef('deleting', 'DELETING');
    world.live = [deleting, active];

    expect(await world.run(null)).toEqual({ requested: 1 });
    expect(world.refreshed.has(deleting.incarnation)).toBe(false);
    expect(world.requested).toEqual([active]);
  });

  it('asks every live cache for eviction', async () => {
    const world = new World();
    const first = cacheRef('first');
    const second = cacheRef('second');
    world.live = [first, second];

    const result = await world.run(null);

    expect(result).toEqual({ requested: 2 });
    expect(world.requested).toEqual([first, second]);
    expect(world.finishedCalls).toEqual([]);
  });

  it('counts only the caches that start a run', async () => {
    const world = new World();
    world.live = [cacheRef('first'), cacheRef('second')];
    world.refuseRequest = true;

    expect(await world.run(null)).toEqual({ requested: 0 });
  });
});
