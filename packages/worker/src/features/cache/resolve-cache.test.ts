import { describe, expect, it, vi } from 'vitest';
import { effectiveLifecycle, getCacheForDeletion } from './resolve-cache';
import type { CacheConfig, CacheReference } from './types';

const notFound = {
  ok: false,
  error: { code: 'not_found', message: 'cache not found', status: 404 },
};

function reference(lifecycle: CacheReference['lifecycle']): CacheReference {
  return {
    id: 'cache-id',
    name: 'cache',
    incarnation: 'incarnation',
    coordinator_id: '0'.repeat(64),
    lifecycle,
  };
}

const config: CacheConfig = {
  id: 'cache-id',
  name: 'cache',
  public: true,
  quota_bytes: 10,
  logical_bytes: 0,
  encoding_id: 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1',
  created_at: 1,
  lifecycle: 'CREATING',
  retention_days: 0,
  eviction_min_age_days: 30,
  last_eviction: null,
  upstream_cache_key_names: [],
};

function environment(lifecycle: CacheReference['lifecycle']) {
  let initialized = false;
  const initialize = vi.fn(async () => {
    initialized = true;
    return { ok: true, value: config };
  });
  const env = {
    SYSTEM_CONTROL: {
      getByName: () => ({
        getCache: async () => ({ ok: true, value: reference(lifecycle) }),
        catalogueConfig: async () => ({ ok: true, value: config }),
      }),
    },
    CACHE_COORDINATOR: {
      idFromString: (id: string) => id,
      get: () => ({
        getCache: async () =>
          initialized ? { ok: true, value: config } : notFound,
        initialize,
      }),
    },
  } as unknown as Env;
  return { env, initialize };
}

describe('resolving a cache for deletion', () => {
  it('initializes the coordinator of an interrupted creation', async () => {
    const { env, initialize } = environment('CREATING');
    await expect(getCacheForDeletion(env, 'cache')).resolves.toMatchObject({
      name: 'cache',
      reference: { incarnation: 'incarnation' },
    });
    expect(initialize).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({ public: true, quota_bytes: 10 }),
    );
  });

  it('never recreates the coordinator of a cache being torn down', async () => {
    const { env, initialize } = environment('DELETING');
    await expect(getCacheForDeletion(env, 'cache')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(initialize).not.toHaveBeenCalled();
  });
});

describe('the effective lifecycle', () => {
  it.each([
    ['DELETING', 'ACTIVE', 'DELETING'],
    ['ACTIVE', 'DELETING', 'DELETING'],
    ['CREATING', 'ACTIVE', 'CREATING'],
    ['ACTIVE', 'CREATING', 'CREATING'],
    ['ACTIVE', 'ACTIVE', 'ACTIVE'],
  ])(
    'catalogue %s with coordinator %s reads %s',
    (catalogue, coordinator, expected) => {
      expect(
        effectiveLifecycle(
          catalogue as CacheReference['lifecycle'],
          coordinator as CacheConfig['lifecycle'],
        ),
      ).toBe(expected);
    },
  );
});
