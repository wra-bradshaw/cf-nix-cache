import { authenticate } from '../auth/authentication';
import {
  assertCacheName,
  assertStoreHash,
  lifecycleFailure,
} from '../domain/validation';
import type {
  CacheConfig,
  CacheReference,
  CacheState,
  PathRecord,
  Role,
} from '../../types';
import {
  ApiCallError,
  idStub,
  indexShard,
  namedStub,
  unwrapRpc,
} from '../../rpc';

export function system(env: Env) {
  return namedStub(env.SYSTEM_CONTROL, 'system');
}

export function coordinator(env: Env, reference: CacheReference) {
  return idStub(env.CACHE_COORDINATOR, reference.coordinator_id);
}

const DIRECTORY_CACHE_TTL = 5;

export function effectiveLifecycle(
  catalogue: CacheReference['lifecycle'],
  coordinatorLifecycle: CacheConfig['lifecycle'],
): CacheConfig['lifecycle'] {
  // DELETING is a safety fence and wins over stale cache entries; CREATING
  // also wins over ACTIVE so activation cannot become visible early.
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
  // Cache API entries written before lifecycle was included are not trusted
  // for routing. Refresh them once from the catalogue so a CREATING cache
  // cannot be served while its coordinator is already ACTIVE.
  if (!reference.lifecycle)
    reference = unwrapRpc(await system(env).getCache(name));
  let configResult = await coordinator(env, reference).getCache();
  // A short-lived directory entry can point at a completed deletion. Refresh
  // once so a cache recreated with the same name is routed to its incarnation.
  if (!configResult.ok && configResult.error.code === 'not_found') {
    reference = unwrapRpc(await system(env).getCache(name));
    configResult = await coordinator(env, reference).getCache();
  }
  const config = unwrapRpc(configResult);
  return {
    ...config,
    // SystemControl is the lifecycle saga authority. During activation and
    // teardown it may intentionally lead the coordinator by one step.
    lifecycle: effectiveLifecycle(reference.lifecycle, config.lifecycle),
    reference,
  };
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

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiCallError && error.code === 'not_found';
}

/** Rejects requests against a cache that is not ACTIVE. */
export function assertActive(cache: CacheState): void {
  const blocked = lifecycleFailure(cache.lifecycle);
  if (blocked) throw blocked;
}

export async function authFor(
  request: Request,
  env: Env,
  cache: CacheState,
  required: Role,
): Promise<{ sub: string }> {
  assertActive(cache);
  if (required === 'pull' && cache.public) return { sub: 'anonymous' };
  return authenticate(request, env, cache.name, required);
}
