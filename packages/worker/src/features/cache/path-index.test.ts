import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiCallError, failure, ok, type RpcResult } from '../../shared/rpc';
import { pathIndex } from './path-index';
import type { CacheReference, PathRecord } from './types';

afterEach(() => {
  vi.restoreAllMocks();
});

const reference: CacheReference = {
  id: 'id',
  name: 'cache',
  incarnation: 'inc',
  coordinator_id: 'coordinator',
  lifecycle: 'ACTIVE',
};

function record(overrides: Partial<PathRecord> = {}): PathRecord {
  return {
    cache: 'cache',
    store_hash: 'ab' + '0'.repeat(30),
    store_path: '/nix/store/ab',
    nar_hash: 'nar',
    nar_size: 10,
    references: [],
    manifest_key: 'manifests/m',
    narinfo: 'narinfo',
    file_hash: 'b'.repeat(64),
    file_size: 100,
    last_accessed: 1000,
    created_at: 1000,
    ...overrides,
  };
}

interface Shard {
  upsert(input: PathRecord): Promise<RpcResult<unknown>>;
  delete(input: {
    store_hash: string;
    unused_before?: number;
  }): Promise<RpcResult<unknown>>;
  clear(): Promise<RpcResult<unknown>>;
  usage(): Promise<RpcResult<{ bytes: number; revision: number }>>;
}

function harness(shard: Partial<Shard> = {}) {
  const names: string[] = [];
  const reports: { prefix: string; bytes: number; revision: number }[] = [];
  const stub: Shard = {
    upsert: async (entry) =>
      ok({ previous_size: null, bytes: entry.file_size, revision: 1 }),
    delete: async () =>
      ok({ freed: 40, existed: true, bytes: 60, revision: 2 }),
    clear: async () => ok({ deleted: 3, bytes: 300, revision: 4 }),
    usage: async () => ok({ bytes: 60, revision: 2 }),
    ...shard,
  };
  const coordinator = {
    reportUsage: async (input: (typeof reports)[number]) => {
      reports.push(input);
      return ok();
    },
  };
  const env = {
    CACHE_INDEX: {
      getByName: (name: string) => {
        names.push(name);
        return stub;
      },
    },
    CACHE_COORDINATOR: {
      idFromString: (id: string) => id,
      get: () => coordinator,
    },
  } as unknown as Env;
  return { index: pathIndex(env, reference), names, reports, coordinator };
}

describe('upserting a path', () => {
  it('upserts into the path shard and reports its new usage', async () => {
    const { index, names, reports } = harness();
    const usage = await index.upsert(record({ file_size: 120 }));

    expect(usage).toEqual({ bytes: 120, revision: 1 });
    expect(names).toEqual(['inc:ab']);
    expect(reports).toEqual([{ prefix: 'ab', bytes: 120, revision: 1 }]);
  });

  it('does not fail the upsert when reporting fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { index, coordinator } = harness();
    coordinator.reportUsage = async () => failure('not_found', 'gone', 404);

    await expect(index.upsert(record())).resolves.toEqual({
      bytes: 100,
      revision: 1,
    });
    expect(log).toHaveBeenCalled();
  });

  it('does not fail the upsert when the coordinator throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { index, coordinator } = harness();
    coordinator.reportUsage = async () => {
      throw new Error('connection reset');
    };

    await expect(index.upsert(record())).resolves.toEqual({
      bytes: 100,
      revision: 1,
    });
    expect(log).toHaveBeenCalled();
  });

  it('surfaces a shard refusal with its code and status', async () => {
    const { index } = harness({
      upsert: async () => failure('cache_deleting', 'deleting', 410),
    });

    const error = await index.upsert(record()).catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiCallError);
    expect(error).toMatchObject({ code: 'cache_deleting', status: 410 });
  });
});

describe('deleting a path', () => {
  it('reports the shard usage and returns what was freed', async () => {
    const deletes: unknown[] = [];
    const { index, reports } = harness({
      delete: async (input) => {
        deletes.push(input);
        return ok({ freed: 40, existed: true, bytes: 60, revision: 2 });
      },
    });

    await expect(
      index.delete(record().store_hash, { unusedBefore: 500 }),
    ).resolves.toEqual({ freed: 40, existed: true });
    expect(deletes).toEqual([
      { store_hash: record().store_hash, unused_before: 500 },
    ]);
    expect(reports).toEqual([{ prefix: 'ab', bytes: 60, revision: 2 }]);
  });

  it('omits the cutoff when there is none', async () => {
    const deletes: unknown[] = [];
    const { index } = harness({
      delete: async (input) => {
        deletes.push(input);
        return ok({ freed: 0, existed: false, bytes: 0, revision: 0 });
      },
    });

    await index.delete(record().store_hash);
    expect(deletes).toEqual([{ store_hash: record().store_hash }]);
  });

  it('surfaces path_in_use', async () => {
    const { index } = harness({
      delete: async () => failure('path_in_use', 'in use', 409),
    });

    await expect(
      index.delete(record().store_hash, { unusedBefore: 500 }),
    ).rejects.toMatchObject({ code: 'path_in_use', status: 409 });
  });

  it('does not fail the delete when reporting fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { index, coordinator } = harness({
      delete: async () =>
        ok({ freed: 40, existed: true, bytes: 60, revision: 2 }),
    });
    coordinator.reportUsage = async () => failure('not_found', 'gone', 404);

    await expect(index.delete(record().store_hash)).resolves.toEqual({
      freed: 40,
      existed: true,
    });
    expect(log).toHaveBeenCalled();
  });
});

describe('clearing a shard', () => {
  it('reports nothing, because the coordinator is going away', async () => {
    const { index, reports, names } = harness();

    await expect(index.clear('zz')).resolves.toEqual({ deleted: 3 });
    expect(names).toEqual(['inc:zz']);
    expect(reports).toEqual([]);
  });
});

describe('refreshing a shard', () => {
  it('reads the shard usage and reports it', async () => {
    const { index, reports } = harness();

    await expect(index.refresh('cd')).resolves.toEqual({
      bytes: 60,
      revision: 2,
    });
    expect(reports).toEqual([{ prefix: 'cd', bytes: 60, revision: 2 }]);
  });
});
