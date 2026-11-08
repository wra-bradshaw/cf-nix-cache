import { assertCacheName, assertStoreHash } from '../../shared/identifiers';
import { ApiCallError, isNotFound, unwrapRpc } from '../../shared/rpc';
import { coordinator, indexShard, system } from './stubs';
import type {
  CacheConfig,
  CacheReference,
  CacheState,
  PathRecord,
} from './types';

const DIRECTORY_CACHE_TTL = 5;

export function effectiveLifecycle(
  catalogue: CacheReference['lifecycle'],
  coordinatorLifecycle: CacheConfig['lifecycle'],
): CacheConfig['lifecycle'] {
  if (catalogue === 'DELETING' || coordinatorLifecycle === 'DELETING')
    return 'DELETING';
  if (catalogue === 'CREATING' || coordinatorLifecycle === 'CREATING')
    return 'CREATING';
  return 'ACTIVE';
}

async function directoryReference(
  env: Env,
  name: string,
): Promise<CacheReference> {
  const key = new Request(`https://directory.invalid/cache/${name}`);
  try {
    const cached = await caches.default.match(key);
    if (cached) return (await cached.json()) as CacheReference;
  } catch {
    // The Cache API is unavailable in some local/unit runtimes; the Durable
    // Object remains the authoritative fallback.
  }

  const reference = unwrapRpc(await system(env).getCache(name));
  try {
    void caches.default
      .put(
        key,
        Response.json(reference, {
          headers: { 'cache-control': `max-age=${DIRECTORY_CACHE_TTL}` },
        }),
      )
      .catch(() => undefined);
  } catch {
    // Best-effort acceleration only; never make routing depend on the cache.
  }
  return reference;
}

export async function getCache(env: Env, name: string): Promise<CacheState> {
  assertCacheName(name);
  let reference = await directoryReference(env, name);
  let configResult = await coordinator(env, reference).getCache();
  if (!configResult.ok && configResult.error.code === 'not_found') {
    reference = unwrapRpc(await system(env).getCache(name));
    configResult = await coordinator(env, reference).getCache();
  }
  const config = unwrapRpc(configResult);
  return {
    ...config,
    lifecycle: effectiveLifecycle(reference.lifecycle, config.lifecycle),
    reference,
  };
}

export async function getCacheForDeletion(
  env: Env,
  name: string,
): Promise<CacheState> {
  try {
    return await getCache(env, name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const reference = unwrapRpc(await system(env).getCache(name));
  if (reference.lifecycle !== 'CREATING')
    throw new ApiCallError(404, 'not_found', 'cache not found');
  const config = unwrapRpc(await system(env).catalogueConfig(reference));
  unwrapRpc(
    await coordinator(env, reference).initialize({
      reference,
      public: config.public,
      quota_bytes: config.quota_bytes,
      encoding_id: config.encoding_id,
      created_at: config.created_at,
      upstream_cache_key_names: config.upstream_cache_key_names,
    }),
  );
  return getCache(env, name);
}

export function publicCache(cache: CacheState): CacheConfig {
  return {
    id: cache.id,
    name: cache.name,
    public: cache.public,
    quota_bytes: cache.quota_bytes,
    logical_bytes: cache.logical_bytes,
    encoding_id: cache.encoding_id,
    created_at: cache.created_at,
    lifecycle: cache.lifecycle,
    retention_days: cache.retention_days,
    upstream_cache_key_names: cache.upstream_cache_key_names,
  };
}

export async function getPath(
  env: Env,
  cache: CacheState,
  storeHash: string,
): Promise<PathRecord> {
  assertStoreHash(storeHash);
  const shard = indexShard(env, cache.reference.incarnation, storeHash);
  return unwrapRpc(await shard.lookup(storeHash));
}

export async function touchPath(
  env: Env,
  cache: CacheState,
  storeHash: string,
): Promise<void> {
  try {
    const shard = indexShard(env, cache.reference.incarnation, storeHash);
    await shard.touch(storeHash);
  } catch (error) {
    console.error('cache touch failed', error);
  }
}
