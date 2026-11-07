import { shardPrefixes } from '../domain/identifiers';
import type { GcJob, GcSummary } from './model';
import type {
  GcCache,
  GcCatalogPort,
  GcLedgerPort,
  GcObjectsPort,
  GcSteps,
} from './ports';

const DEFAULT_GRACE_SECONDS = 24 * 60 * 60;
/** Bucket prefixes of content-addressed objects. Staging is never touched. */
const SWEPT_PREFIXES = ['manifests/', 'chunks/'];
const SHARDS_PER_STEP = 128;
const SHARDS_PER_EVICTION_STEP = 32;
const SHARD_PAGE = 500;
const MANIFESTS_PER_STEP = 256;
const CONCURRENCY = 16;
// The most keys one R2 list response or multi-delete request can carry.
const R2_BATCH = 1000;

async function forEachLimit<T>(
  items: readonly T[],
  body: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(CONCURRENCY, items.length) },
      async function worker() {
        while (next < items.length) await body(items[next++]!);
      },
    ),
  );
}

function batches<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    result.push(items.slice(start, start + size));
  return result;
}

interface ShardCursor {
  prefix: string;
  after: string | null;
}

export interface GcPorts {
  ledger: GcLedgerPort;
  catalog: GcCatalogPort;
  objects: GcObjectsPort;
}

/**
 * Runs one garbage collection. Every side effect happens inside a step, and
 * every step is safe to repeat, so a retried or replayed run converges.
 *
 * Any failure aborts the run before further deletion: an incomplete view of
 * what is live must never be treated as a complete one.
 */
export async function runGarbageCollection(
  input: {
    run_id: string;
    /** Fixed for the run, so that replays compute the same cutoffs. */
    now: number;
    job: GcJob;
  },
  ports: GcPorts,
  step: GcSteps,
  clock: () => number,
): Promise<GcSummary | { skipped: true }> {
  const { ledger, catalog, objects } = ports;
  const dryRun = input.job.dry_run ?? false;
  const graceSeconds = input.job.grace_seconds ?? DEFAULT_GRACE_SECONDS;
  const summary: GcSummary = {
    run_id: input.run_id,
    dry_run: dryRun,
    outcome: 'success',
    started_at: input.now,
    finished_at: input.now,
    evicted_paths: 0,
    skipped_paths: 0,
    marked_objects: 0,
    missing_manifests: 0,
    deleted_objects: 0,
    deleted_bytes: 0,
  };

  const started = await step.do('begin', () =>
    ledger.begin({ dry_run: dryRun }),
  );
  if (!started) return { skipped: true };

  const expandMarks = async (stage: string): Promise<void> => {
    for (let page = 0; ; page += 1) {
      const result = await step.do(`expand ${stage} ${page}`, async () => {
        const keys = await ledger.pendingManifests(MANIFESTS_PER_STEP);
        const manifests: { key: string; chunk_keys: string[] }[] = [];
        let missing = 0;
        await forEachLimit(keys, async (key) => {
          const chunkKeys = await objects.manifestChunks(key);
          if (!chunkKeys) missing += 1;
          manifests.push({ key, chunk_keys: chunkKeys ?? [] });
        });
        await ledger.expand(manifests);
        return { done: keys.length < MANIFESTS_PER_STEP, missing };
      });
      summary.missing_manifests += result.missing;
      if (result.done) return;
    }
  };

  try {
    const caches = await step.do('list caches', () => catalog.liveCaches());

    for (const cache of caches)
      if (cache.retention_days > 0) await evict(cache);

    for (const cache of caches)
      for (const [index, prefixes] of batches(
        shardPrefixes(),
        SHARDS_PER_STEP,
      ).entries())
        await step.do(`mark ${cache.incarnation} ${index}`, async () => {
          const keys = new Set<string>();
          await forEachLimit(prefixes, async (prefix) => {
            let after: string | null = null;
            do {
              const page: { keys: string[]; next_after: string | null } =
                await catalog.manifestKeys(cache, prefix, after, SHARD_PAGE);
              for (const key of page.keys) keys.add(key);
              after = page.next_after;
            } while (after);
          });
          await ledger.addMarks([...keys]);
          return { marked: keys.size };
        });

    await expandMarks('walk');

    // Listing happens with the gate open, so a run that finds nothing to
    // delete never delays an upload, however large the bucket is.
    const cutoff = input.now - graceSeconds;
    for (const prefix of SWEPT_PREFIXES) {
      let cursor: string | null = null;
      for (let page = 0; ; page += 1) {
        const listed: string | null = await step.do(
          `list ${prefix} ${page}`,
          async () => {
            const result = await objects.list(prefix, cursor, R2_BATCH);
            await ledger.addCandidates(
              result.objects
                .filter((object) => object.uploaded < cutoff)
                .map(({ key, size }) => ({ key, size })),
            );
            return result.cursor;
          },
        );
        cursor = listed;
        if (!cursor) break;
      }
    }

    const found = await step.do('count candidates', () =>
      ledger.candidateTotals(),
    );
    if (dryRun || found.objects === 0) {
      summary.deleted_objects = found.objects;
      summary.deleted_bytes = found.bytes;
    } else {
      for (let poll = 0; ; poll += 1) {
        const drained = await step.do(`close gate ${poll}`, () =>
          ledger.closeGate(),
        );
        if (drained) break;
        await step.sleep(`wait for uploads ${poll}`, '30 seconds');
      }
      // Uploads that finished during the run may have reused candidates.
      await expandMarks('drain');
      for (let page = 0; ; page += 1) {
        const deleted = await step.do(`delete ${page}`, async () => {
          const next = await ledger.nextDeletions(R2_BATCH);
          if (next.length > 0) {
            const keys = next.map((object) => object.key);
            await objects.delete(keys);
            await ledger.markDeleted(keys);
          }
          return {
            objects: next.length,
            bytes: next.reduce((sum, object) => sum + object.size, 0),
          };
        });
        summary.deleted_objects += deleted.objects;
        summary.deleted_bytes += deleted.bytes;
        if (deleted.objects < R2_BATCH) break;
      }
    }
    summary.marked_objects = found.marked;
    summary.finished_at = clock();
    await step.do('finish', async () => {
      await ledger.finish(summary);
      return { finished: true };
    });
    return summary;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    // Reopens the gate right away rather than when the run's deadline lapses.
    await step.do('record failure', async () => {
      await ledger.finish({
        ...summary,
        outcome: 'failed',
        finished_at: clock(),
        error: message.slice(0, 2000),
      });
      return { finished: true };
    });
    throw caught;
  }

  async function evict(cache: GcCache): Promise<void> {
    const before = input.now - cache.retention_days * 24 * 60 * 60;
    const prefixes = shardPrefixes();
    let nextPrefix = 0;
    // Shards with more expired paths than one page come round again, so a step
    // stays bounded however many paths have expired.
    let unfinished: ShardCursor[] = [];
    let evictedInCache = 0;
    for (let page = 0; ; page += 1) {
      const taken = unfinished.slice(0, SHARDS_PER_EVICTION_STEP);
      const fresh = prefixes
        .slice(nextPrefix, nextPrefix + SHARDS_PER_EVICTION_STEP - taken.length)
        .map((prefix): ShardCursor => ({ prefix, after: null }));
      if (taken.length === 0 && fresh.length === 0) break;
      const result = await step.do(
        `evict ${cache.incarnation} ${page}`,
        async () => {
          let evicted = 0;
          let skipped = 0;
          const more: ShardCursor[] = [];
          await forEachLimit(
            [...taken, ...fresh],
            async ({ prefix, after }) => {
              const expired = await catalog.expiredPaths(
                cache,
                prefix,
                before,
                after,
                SHARD_PAGE,
              );
              if (expired.next_after)
                more.push({ prefix, after: expired.next_after });
              if (dryRun) {
                evicted += expired.hashes.length;
                return;
              }
              for (const hash of expired.hashes) {
                if (
                  await catalog.evict(cache, hash, `gc:${input.run_id}:${hash}`)
                )
                  evicted += 1;
                else skipped += 1;
              }
            },
          );
          // Sorted because shards finish in no fixed order, and a replay must
          // see the same cursors in the same order.
          more.sort((left, right) => left.prefix.localeCompare(right.prefix));
          return { evicted, skipped, more };
        },
      );
      nextPrefix += fresh.length;
      unfinished = [...unfinished.slice(taken.length), ...result.more];
      evictedInCache += result.evicted;
      summary.evicted_paths += result.evicted;
      summary.skipped_paths += result.skipped;
    }
    if (evictedInCache > 0 && !dryRun)
      await step.do(`audit eviction ${cache.incarnation}`, async () => {
        await catalog.auditEviction(cache, input.run_id, evictedInCache);
        return { audited: true };
      });
  }
}
