import { ChunkManifestSchema, parseJsonSchema } from '../../shared/schemas';
import {
  MUTATION_IN_PROGRESS,
  publicationFor,
} from '../cache/publication-adapters';
import { PublicationError } from '../cache/publication-protocol';
import { coordinator, system, indexShard } from '../cache/stubs';
import { namedStub, unwrapRpc } from '../../shared/rpc';
import { collectPages } from '../../shared/sql';
import type { CacheState } from '../cache/types';
import type { GcPorts } from './garbage-collection';
import type { GcCache } from './gc-ports';

export function gcControl(env: Env) {
  return namedStub(env.GC_CONTROL, 'gc');
}

type DurableGcCache = GcCache & { state: CacheState };

export function gcPorts(env: Env, runId: string): GcPorts {
  const control = gcControl(env);
  const stateOf = (cache: GcCache): CacheState =>
    (cache as DurableGcCache).state;
  return {
    ledger: {
      begin: async (input) =>
        unwrapRpc(await control.begin({ ...input, run_id: runId })).started,
      addMarks: async (keys) => {
        if (keys.length === 0) return;
        unwrapRpc(await control.addMarks({ run_id: runId, keys }));
      },
      pendingManifests: async (limit) =>
        unwrapRpc(await control.pendingManifests({ run_id: runId, limit })),
      expand: async (manifests) => {
        unwrapRpc(await control.expand({ run_id: runId, manifests }));
      },
      addCandidates: async (objects) => {
        unwrapRpc(await control.addCandidates({ run_id: runId, objects }));
      },
      candidateTotals: async () =>
        unwrapRpc(await control.candidateTotals({ run_id: runId })),
      closeGate: async () =>
        unwrapRpc(await control.closeGate({ run_id: runId })).drained,
      nextDeletions: async (limit) =>
        unwrapRpc(await control.nextDeletions({ run_id: runId, limit })),
      markDeleted: async (keys) => {
        unwrapRpc(await control.markDeleted({ run_id: runId, keys }));
      },
      finish: async (summary) => {
        unwrapRpc(await control.finish(summary));
      },
    },
    catalog: {
      liveCaches: async () => {
        const references = await collectPages(async (after) =>
          unwrapRpc(await system(env).listCaches({ after, limit: 100 })),
        );
        const caches: DurableGcCache[] = [];
        for (const reference of references) {
          // Once deleting, a cache never serves again, so its paths must not
          // keep objects alive.
          if (reference.lifecycle === 'DELETING') continue;
          const config = unwrapRpc(
            await coordinator(env, reference).getCache(),
          );
          if (config.lifecycle === 'DELETING') continue;
          caches.push({
            name: reference.name,
            incarnation: reference.incarnation,
            retention_days: config.retention_days,
            state: { ...config, reference },
          });
        }
        return caches;
      },
      manifestKeys: async (cache, prefix, after, limit) =>
        unwrapRpc(
          await indexShard(env, cache.incarnation, prefix).manifestKeys({
            after,
            limit,
          }),
        ),
      expiredPaths: async (cache, prefix, before, after, limit) =>
        unwrapRpc(
          await indexShard(env, cache.incarnation, prefix).expiredPaths({
            before,
            after,
            limit,
          }),
        ),
      evict: async (cache, storeHash, operationId) => {
        try {
          await publicationFor(env, stateOf(cache), storeHash).execute(
            operationId,
            { kind: 'delete', store_hash: storeHash },
          );
          return true;
        } catch (error) {
          // A conflicting publication or a cache going away. The next run
          // reconsiders the path; anything else fails this step and retries.
          if (
            error instanceof PublicationError &&
            (!error.retryable || error.code === MUTATION_IN_PROGRESS)
          )
            return false;
          throw error;
        }
      },
      auditEviction: async (cache, id, paths) => {
        unwrapRpc(
          await coordinator(env, stateOf(cache).reference).recordAudit({
            id: `gc-evict:${id}:${cache.incarnation}`,
            timestamp: Math.floor(Date.now() / 1000),
            actor: 'garbage-collector',
            action: 'cache.evict',
            resource: cache.name,
            outcome: 'success',
            metadata: { paths: String(paths), run_id: id },
          }),
        );
      },
    },
    objects: {
      manifestChunks: async (key) => {
        const object = await env.CACHE_BUCKET.get(key);
        if (!object) return null;
        const manifest = parseJsonSchema(
          ChunkManifestSchema,
          await object.json<unknown>(),
        );
        return manifest.chunks.map((chunk) => chunk.key);
      },
      list: async (prefix, cursor, limit) => {
        const page = await env.CACHE_BUCKET.list({
          prefix,
          limit,
          ...(cursor ? { cursor } : {}),
        });
        return {
          objects: page.objects.map((object) => ({
            key: object.key,
            size: object.size,
            uploaded: Math.floor(object.uploaded.getTime() / 1000),
          })),
          cursor: page.truncated ? page.cursor : null,
        };
      },
      delete: async (keys) => {
        await env.CACHE_BUCKET.delete(keys);
      },
    },
  };
}
