import { pathIndex } from '../cache/path-index';
import { coordinator, indexShard, system } from '../cache/stubs';
import type { CacheReference } from '../cache/types';
import { mapLimit } from '../../shared/concurrency';
import { ApiCallError, unwrapRpc } from '../../shared/rpc';
import { collectPages } from '../../shared/sql';
import type { EvictionPorts } from './eviction-ports';
import type { EvictionCacheRef } from './types';

const CONCURRENCY = 16;

function reference(
  cache: EvictionCacheRef,
  lifecycle: CacheReference['lifecycle'] = 'ACTIVE',
): CacheReference {
  return { ...cache, lifecycle };
}

export function evictionPorts(env: Env): EvictionPorts {
  return {
    liveCaches: async () =>
      (
        await collectPages(async (after) =>
          unwrapRpc(await system(env).listCaches({ after, limit: 100 })),
        )
      ).map(({ id, name, incarnation, coordinator_id, lifecycle }) => ({
        id,
        name,
        incarnation,
        coordinator_id,
        lifecycle,
      })),
    requestEviction: async (cache) =>
      unwrapRpc(await coordinator(env, reference(cache)).requestEviction())
        .requested,
    refreshUsage: async (cache, prefixes) => {
      const index = pathIndex(env, reference(cache));
      await mapLimit(prefixes, CONCURRENCY, (prefix) => index.refresh(prefix));
    },
    cacheConfig: async (cache) => {
      const result = await coordinator(env, reference(cache)).getCache();
      if (!result.ok && result.error.code === 'not_found') return null;
      return unwrapRpc(result);
    },
    accessHistogram: async (cache, prefix, before) =>
      unwrapRpc(
        await indexShard(env, cache.incarnation, prefix).accessHistogram({
          before,
        }),
      ).map(([hour, bytes]) => [hour!, bytes!] as [number, number]),
    expiredPaths: async (cache, prefix, before, after, limit) =>
      unwrapRpc(
        await indexShard(env, cache.incarnation, prefix).expiredPaths({
          before,
          after,
          limit,
        }),
      ),
    evict: async (cache, config, storeHash, before) => {
      try {
        return (
          await pathIndex(env, reference(cache, config.lifecycle)).delete(
            storeHash,
            { unusedBefore: before },
          )
        ).freed;
      } catch (error) {
        if (!(error instanceof ApiCallError)) throw error;
        if (error.status >= 500) throw error;
        return null;
      }
    },
    finished: async (cache, generation, result) => {
      const finished = await coordinator(
        env,
        reference(cache),
      ).evictionFinished({ generation, result });
      // The cache was deleted during the run.
      if (!finished.ok && finished.error.code === 'not_found') return;
      unwrapRpc(finished);
    },
    audit: async (cache, result) => {
      unwrapRpc(
        await coordinator(env, reference(cache)).recordAudit({
          id: `evict:${result.run_id}`,
          timestamp: result.finished_at,
          actor: 'eviction',
          action: 'cache.evict',
          resource: cache.name,
          outcome: 'success',
          metadata: {
            run_id: result.run_id,
            paths: String(result.evicted_paths),
            bytes: String(result.evicted_bytes),
            cutoff: result.cutoff === null ? '' : String(result.cutoff),
          },
        }),
      );
    },
  };
}
