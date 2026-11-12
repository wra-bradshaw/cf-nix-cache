import { shardPrefixes } from '../cache/shards';
import type { GcJob, GcSummary } from './types';
import type {
  GcCache,
  GcCatalogPort,
  GcLedgerPort,
  GcObjectsPort,
  GcSteps,
} from './gc-ports';

const DEFAULT_GRACE_SECONDS = 24 * 60 * 60;
const SWEPT_PREFIXES = ['manifests/', 'chunks/'];
const SHARDS_PER_STEP = 128;
const PRUNE_PAGE = 200;
// Longer than any retry of an operation: Workflow step retries and CLI
// retries end within hours.
const PRUNE_AFTER_SECONDS = 7 * 24 * 60 * 60;
const SHARD_PAGE = 500;
const MANIFESTS_PER_STEP = 256;
const CONCURRENCY = 16;
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

export interface GcPorts {
  ledger: GcLedgerPort;
  catalog: GcCatalogPort;
  objects: GcObjectsPort;
}

export async function runGarbageCollection(
  input: {
    run_id: string;
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

  let caches: GcCache[];
  try {
    caches = await step.do('list caches', () => catalog.liveCaches());

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
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
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
  // After the run has finished, so the upload gate is open and the ledger
  // needs no calls. A failure here leaves the run's result as it is.
  if (!dryRun) for (const cache of caches) await prune(cache);
  return summary;

  async function prune(cache: GcCache): Promise<void> {
    const before = input.now - PRUNE_AFTER_SECONDS;
    let after: string | null = null;
    for (let page = 0; ; page += 1) {
      const stale: { upload_ids: string[]; next_after: string | null } =
        await step.do(`prune uploads list ${cache.incarnation} ${page}`, () =>
          catalog.staleUploads(cache, before, after, PRUNE_PAGE),
        );
      if (stale.upload_ids.length)
        await step.do(
          `prune uploads purge ${cache.incarnation} ${page}`,
          async () => {
            const purged: string[] = [];
            await forEachLimit(stale.upload_ids, async (id) => {
              if (await catalog.purgeUpload(id)) purged.push(id);
            });
            await catalog.forgetUploads(cache, purged);
            return { purged: purged.length };
          },
        );
      after = stale.next_after;
      if (!after) break;
    }
  }
}
