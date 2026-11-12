/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PathRecord } from '../types';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

const { CacheIndexShard } = await import('./index-shard');

afterEach(() => {
  vi.restoreAllMocks();
});

function now(seconds: number): void {
  vi.spyOn(Date, 'now').mockReturnValue(seconds * 1000);
}

function record(overrides: Partial<PathRecord> = {}): PathRecord {
  return {
    cache: 'cache',
    store_hash: 'a'.repeat(32),
    store_path: '/nix/store/aaa',
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

function setupShard(): {
  db: DatabaseSync;
  shard: InstanceType<typeof CacheIndexShard>;
} {
  const db = new DatabaseSync(':memory:');
  const exec = (query: string, ...args: unknown[]) => {
    const verb = query.trimStart().split(/\s+/)[0]!.toUpperCase();
    if (
      args.length > 0 ||
      verb === 'SELECT' ||
      verb === 'PRAGMA' ||
      verb === 'WITH'
    )
      return db.prepare(query).all(...(args as string[]));
    db.exec(query);
    return [];
  };
  const ctx = {
    storage: {
      sql: { exec },
      transactionSync: <T>(body: () => T): T => {
        db.exec('BEGIN');
        try {
          const result = body();
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    },
  } as unknown as DurableObjectState;
  return { db, shard: new CacheIndexShard(ctx, {} as Env) };
}

function insertPath(
  db: DatabaseSync,
  overrides: Partial<PathRecord> & { store_hash: string },
): PathRecord {
  const entry = record(overrides);
  db.prepare(
    'INSERT INTO paths (store_hash, record, file_size, last_accessed, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    entry.store_hash,
    JSON.stringify(entry),
    entry.file_size,
    entry.last_accessed,
    entry.created_at,
  );
  return entry;
}

function lastAccessed(db: DatabaseSync, storeHash: string): number {
  return (
    db
      .prepare('SELECT last_accessed AS value FROM paths WHERE store_hash = ?')
      .get(storeHash) as { value: number }
  ).value;
}

function storedBytes(db: DatabaseSync): number {
  return (
    db
      .prepare('SELECT COALESCE(SUM(file_size), 0) AS value FROM paths')
      .get() as { value: number }
  ).value;
}

const HASH = 'a'.repeat(32);

describe('looking a path up', () => {
  it('returns the stored record', async () => {
    const { db, shard } = setupShard();
    now(2000);
    const entry = insertPath(db, { store_hash: HASH });
    const found = await shard.lookup(HASH);
    expect(found).toMatchObject({ ok: true });
    if (found.ok) {
      expect(found.value).toMatchObject({ store_hash: HASH });
      expect(found.value.file_size).toBe(entry.file_size);
    }
  });

  it('misses a path that was never stored', async () => {
    const { shard } = setupShard();
    now(2000);
    await expect(shard.lookup(HASH)).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('leaves an access time from the last hour alone', async () => {
    const { db, shard } = setupShard();
    insertPath(db, { store_hash: HASH, last_accessed: 1000 });
    now(1000 + 1800);
    await shard.lookup(HASH);
    expect(lastAccessed(db, HASH)).toBe(1000);
  });

  it('records an access older than an hour', async () => {
    const { db, shard } = setupShard();
    insertPath(db, { store_hash: HASH, last_accessed: 1000 });
    now(1000 + 7200);
    await shard.lookup(HASH);
    expect(lastAccessed(db, HASH)).toBe(1000 + 7200);
  });
});

describe('writing paths', () => {
  it('stores a new path and derives its usage from the rows', async () => {
    const { db, shard } = setupShard();
    const result = await shard.upsert(record({ file_size: 120 }));

    expect(result).toEqual({
      ok: true,
      value: { previous_size: null, bytes: 120, revision: 1 },
    });
    expect(storedBytes(db)).toBe(120);
    await expect(shard.usage()).resolves.toEqual({
      ok: true,
      value: { bytes: 120, revision: 1 },
    });
  });

  it('accounts for a replacement with a bigger file', async () => {
    const { db, shard } = setupShard();
    await shard.upsert(record({ file_size: 100 }));
    const result = await shard.upsert(record({ file_size: 250 }));

    expect(result).toEqual({
      ok: true,
      value: { previous_size: 100, bytes: 250, revision: 2 },
    });
    expect(storedBytes(db)).toBe(250);
  });

  it('accounts for a replacement with a smaller file', async () => {
    const { db, shard } = setupShard();
    await shard.upsert(record({ file_size: 250 }));
    const result = await shard.upsert(record({ file_size: 40 }));

    expect(result).toEqual({
      ok: true,
      value: { previous_size: 250, bytes: 40, revision: 2 },
    });
    expect(storedBytes(db)).toBe(40);
  });

  it('reports the bytes and existence of a deleted path', async () => {
    const { db, shard } = setupShard();
    await shard.upsert(record({ store_hash: HASH, file_size: 100 }));
    await shard.upsert(record({ store_hash: 'b'.repeat(32), file_size: 30 }));

    const deleted = await shard.delete({ store_hash: HASH });

    expect(deleted).toEqual({
      ok: true,
      value: { freed: 100, existed: true, bytes: 30, revision: 3 },
    });
    expect(storedBytes(db)).toBe(30);
  });

  it('leaves the revision alone when there is nothing to delete', async () => {
    const { shard } = setupShard();
    await shard.upsert(record({ file_size: 100 }));

    const deleted = await shard.delete({ store_hash: 'c'.repeat(32) });

    expect(deleted).toEqual({
      ok: true,
      value: { freed: 0, existed: false, bytes: 100, revision: 1 },
    });
  });

  it('clears every path, fences the shard, and stays idempotent', async () => {
    const { db, shard } = setupShard();
    await shard.upsert(record({ store_hash: HASH, file_size: 100 }));
    await shard.upsert(record({ store_hash: 'b'.repeat(32), file_size: 50 }));

    const cleared = await shard.clear();

    expect(cleared).toEqual({
      ok: true,
      value: { deleted: 2, bytes: 150, revision: 3 },
    });
    expect(storedBytes(db)).toBe(0);
    await expect(shard.clear()).resolves.toEqual({
      ok: true,
      value: { deleted: 0, bytes: 0, revision: 4 },
    });
    await expect(shard.upsert(record())).resolves.toMatchObject({
      ok: false,
      error: { code: 'cache_deleting', status: 410 },
    });
  });

  it('refuses an upsert while fenced', async () => {
    const { shard } = setupShard();
    await shard.clear();

    await expect(shard.upsert(record({ file_size: 100 }))).resolves.toEqual({
      ok: false,
      error: {
        code: 'cache_deleting',
        message: 'cache index is fenced for deletion',
        status: 410,
      },
    });
    await expect(shard.usage()).resolves.toMatchObject({
      ok: true,
      value: { bytes: 0 },
    });
  });
});

describe('the eviction guard', () => {
  it('refuses a delete for a path used at or after the cutoff', async () => {
    const { db, shard } = setupShard();
    insertPath(db, { store_hash: HASH, last_accessed: 5000 });

    await expect(
      shard.delete({ store_hash: HASH, unused_before: 4000 }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'path_in_use', status: 409 },
    });
    await expect(
      shard.delete({ store_hash: HASH, unused_before: 5000 }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'path_in_use', status: 409 },
    });
    expect(storedBytes(db)).toBe(100);
    await expect(shard.usage()).resolves.toMatchObject({
      ok: true,
      value: { bytes: 100, revision: 0 },
    });
  });

  it('deletes a path last used before the cutoff', async () => {
    const { db, shard } = setupShard();
    insertPath(db, { store_hash: HASH, last_accessed: 5000 });
    await expect(
      shard.delete({ store_hash: HASH, unused_before: 6000 }),
    ).resolves.toMatchObject({
      ok: true,
      value: { freed: 100, existed: true },
    });
  });

  it('lets a delete of a missing path through', async () => {
    const { shard } = setupShard();
    await expect(
      shard.delete({ store_hash: HASH, unused_before: 6000 }),
    ).resolves.toMatchObject({
      ok: true,
      value: { freed: 0, existed: false },
    });
  });
});

describe('the access histogram', () => {
  it('groups bytes of paths older than before by hour of last use', async () => {
    const { db, shard } = setupShard();
    now(10_000);
    insertPath(db, { store_hash: HASH, last_accessed: 3600, file_size: 100 });
    insertPath(db, {
      store_hash: 'b'.repeat(32),
      last_accessed: 3700,
      file_size: 50,
    });
    insertPath(db, {
      store_hash: 'c'.repeat(32),
      last_accessed: 7210,
      file_size: 25,
    });
    insertPath(db, {
      store_hash: 'd'.repeat(32),
      last_accessed: 9000,
      file_size: 1000,
    });

    const histogram = await shard.accessHistogram({ before: 8000 });
    if (!histogram.ok) throw new Error('expected a histogram');
    expect(histogram.value.sort((a, b) => a[0] - b[0])).toEqual([
      [1, 150],
      [2, 25],
    ]);
  });

  it('rejects a missing before', async () => {
    const { shard } = setupShard();
    await expect(shard.accessHistogram({ before: NaN })).resolves.toMatchObject(
      {
        ok: false,
        error: { code: 'invalid_before' },
      },
    );
  });
});
