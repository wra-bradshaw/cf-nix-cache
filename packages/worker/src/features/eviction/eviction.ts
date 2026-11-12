import { shardPrefixes } from '../cache/shards';
import { mapLimit } from '../../shared/concurrency';
import type { EvictionPorts, EvictionSteps } from './eviction-ports';
import { DAY_SECONDS, bytesToFree, cutoffFor, mergeBuckets } from './policy';
import type { EvictionJob, EvictionResult } from './types';

const SHARDS_PER_HISTOGRAM_STEP = 64;
const SHARDS_PER_REFRESH_STEP = 64;
const SHARDS_PER_EVICTION_STEP = 32;
const SHARD_PAGE = 500;
const CONCURRENCY = 16;

interface ShardCursor {
  prefix: string;
  after: string | null;
}

function batches<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    result.push(items.slice(start, start + size));
  return result;
}

// The scheduled daily run asks every cache whether it needs eviction, which
// starts retention runs and catches a quota run the push path missed. A run
// for one cache removes least recently used paths until the cache is under
// its target, and paths past `retention_days`. It only removes index rows;
// garbage collection later deletes the objects nothing references.
export async function runEviction(
  input: { run_id: string; now: number; job: EvictionJob | null },
  ports: EvictionPorts,
  step: EvictionSteps,
  clock: () => number,
): Promise<EvictionResult | { requested: number }> {
  const { job } = input;
  if (!job) {
    const caches = await step.do('list caches', () => ports.liveCaches());
    let requested = 0;
    for (const cache of caches) {
      if (cache.lifecycle !== 'ACTIVE') continue;
      for (const [index, prefixes] of batches(
        shardPrefixes(),
        SHARDS_PER_REFRESH_STEP,
      ).entries())
        await step.do(`refresh ${cache.incarnation} ${index}`, async () => {
          await ports.refreshUsage(cache, prefixes);
          return { refreshed: prefixes.length };
        });
      if (
        await step.do(`request ${cache.incarnation}`, () =>
          ports.requestEviction(cache),
        )
      )
        requested += 1;
    }
    return { requested };
  }

  const cache = job.cache;
  const config = await step.do('plan', () => ports.cacheConfig(cache));
  // A deleted cache's paths go with it.
  if (!config || config.lifecycle !== 'ACTIVE') return emptyResult(input);

  const floor = input.now - config.eviction_min_age_days * DAY_SECONDS;
  const target =
    config.eviction_min_age_days > 0
      ? bytesToFree(config.logical_bytes, config.quota_bytes)
      : 0;
  let quota: { cutoff: number | null; floor_reached: boolean } = {
    cutoff: null,
    floor_reached: false,
  };
  if (target > 0) {
    const buckets: [number, number][] = [];
    for (const [index, prefixes] of batches(
      shardPrefixes(),
      SHARDS_PER_HISTOGRAM_STEP,
    ).entries())
      buckets.push(
        // Merged by hour within the step, so its output stays far below
        // the step size limit: at most one entry per hour of history.
        ...(await step.do(`histogram ${index}`, async () =>
          mergeBuckets(
            (
              await mapLimit(prefixes, CONCURRENCY, (prefix) =>
                ports.accessHistogram(cache, prefix, floor),
              )
            ).flat(),
          ),
        )),
      );
    quota = cutoffFor(buckets, target, floor);
  }
  const retention =
    config.retention_days > 0
      ? input.now - config.retention_days * DAY_SECONDS
      : null;
  const cutoff =
    quota.cutoff === null
      ? retention
      : retention === null
        ? quota.cutoff
        : Math.max(quota.cutoff, retention);

  const result: EvictionResult = {
    ...emptyResult(input),
    target_bytes: target,
    cutoff,
    floor_reached:
      quota.floor_reached && (retention === null || retention <= floor),
  };
  if (cutoff !== null) await evictBefore(cutoff);
  result.finished_at = clock();
  if (result.evicted_paths > 0)
    await step.do('audit', async () => {
      await ports.audit(cache, result);
      return { audited: true };
    });
  await step.do('finish', async () => {
    await ports.finished(cache, job.generation, result);
    return { finished: true };
  });
  return result;

  async function evictBefore(before: number): Promise<void> {
    const prefixes = shardPrefixes();
    let nextPrefix = 0;
    let unfinished: ShardCursor[] = [];
    for (let page = 0; ; page += 1) {
      const taken = unfinished.slice(0, SHARDS_PER_EVICTION_STEP);
      const fresh = prefixes
        .slice(nextPrefix, nextPrefix + SHARDS_PER_EVICTION_STEP - taken.length)
        .map((prefix): ShardCursor => ({ prefix, after: null }));
      if (taken.length === 0 && fresh.length === 0) break;
      const progress = await step.do(`evict ${page}`, async () => {
        let evicted = 0;
        let bytes = 0;
        let skipped = 0;
        const more: ShardCursor[] = [];
        await mapLimit(
          [...taken, ...fresh],
          CONCURRENCY,
          async ({ prefix, after }) => {
            const expired = await ports.expiredPaths(
              cache,
              prefix,
              before,
              after,
              SHARD_PAGE,
            );
            if (expired.next_after)
              more.push({ prefix, after: expired.next_after });
            for (const hash of expired.hashes) {
              const freed = await ports.evict(cache, config!, hash, before);
              if (freed === null) skipped += 1;
              else {
                evicted += 1;
                bytes += freed;
              }
            }
          },
        );
        more.sort((left, right) => left.prefix.localeCompare(right.prefix));
        return { evicted, bytes, skipped, more };
      });
      nextPrefix += fresh.length;
      unfinished = [...unfinished.slice(taken.length), ...progress.more];
      result.evicted_paths += progress.evicted;
      result.evicted_bytes += progress.bytes;
      result.skipped_paths += progress.skipped;
    }
  }
}

function emptyResult(input: { run_id: string; now: number }): EvictionResult {
  return {
    run_id: input.run_id,
    started_at: input.now,
    finished_at: input.now,
    target_bytes: 0,
    cutoff: null,
    evicted_paths: 0,
    evicted_bytes: 0,
    skipped_paths: 0,
    floor_reached: false,
  };
}
