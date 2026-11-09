import {
  MUTATION_IN_PROGRESS,
  publicationFor,
} from '../cache/publication-adapters';
import { PublicationError } from '../cache/publication-protocol';
import { coordinator, indexShard, system } from '../cache/stubs';
import type { CacheReference } from '../cache/types';
import { unwrapRpc } from '../../shared/rpc';
import { collectPages } from '../../shared/sql';
import type { EvictionPorts } from './eviction-ports';
import type { EvictionCacheRef } from './types';

const PATH_IN_USE = 'path_in_use';

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
      )
        .filter((cache) => cache.lifecycle === 'ACTIVE')
        .map(({ id, name, incarnation, coordinator_id }) => ({
          id,
          name,
          incarnation,
          coordinator_id,
        })),
    requestEviction: async (cache) =>
      unwrapRpc(await coordinator(env, reference(cache)).requestEviction())
        .requested,
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
    evict: async (cache, config, storeHash, before, operationId) => {
      try {
        const prepared = await publicationFor(
          env,
          { ...config, reference: reference(cache, config.lifecycle) },
          storeHash,
        ).execute(operationId, {
          kind: 'delete',
          store_hash: storeHash,
          unused_before: before,
        });
        return prepared.previous?.file_size ?? 0;
      } catch (error) {
        if (
          error instanceof PublicationError &&
          (error.code === PATH_IN_USE ||
            error.code === MUTATION_IN_PROGRESS ||
            !error.retryable)
        )
          return null;
        throw error;
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
