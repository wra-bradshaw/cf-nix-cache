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

function operationStatus(db: DatabaseSync, operationId: string): string {
  return (
    db
      .prepare(
        'SELECT status AS value FROM index_operations WHERE operation_id = ?',
      )
      .get(operationId) as { value: string }
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

describe('the eviction guard', () => {
  it('refuses a delete in prepare for a path used at or after the cutoff', async () => {
    const { db, shard } = setupShard();
    now(9000);
    insertPath(db, { store_hash: HASH, last_accessed: 5000 });
    await expect(
      shard.prepare({
        operation_id: 'evict-old',
        mutation: { kind: 'delete', store_hash: HASH, unused_before: 4000 },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'path_in_use', status: 409 },
    });
    await expect(
      shard.prepare({
        operation_id: 'evict-equal',
        mutation: { kind: 'delete', store_hash: HASH, unused_before: 5000 },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'path_in_use', status: 409 },
    });
    await expect(
      shard.prepare({
        operation_id: 'evict-fresh',
        mutation: { kind: 'delete', store_hash: HASH, unused_before: 6000 },
      }),
    ).resolves.toMatchObject({ ok: true, value: { status: 'PREPARED' } });
  });

  it('refuses a delete for a missing path guard by letting it through', async () => {
    const { shard } = setupShard();
    now(9000);
    await expect(
      shard.prepare({
        operation_id: 'evict-missing',
        mutation: { kind: 'delete', store_hash: HASH, unused_before: 6000 },
      }),
    ).resolves.toMatchObject({ ok: true, value: { status: 'PREPARED' } });
  });

  it('refuses a commit after a lookup between prepare and commit, and aborts the operation', async () => {
    const { db, shard } = setupShard();
    insertPath(db, { store_hash: HASH, last_accessed: 1000 });
    now(2000);
    await expect(
      shard.prepare({
        operation_id: 'evict-race',
        mutation: { kind: 'delete', store_hash: HASH, unused_before: 5000 },
      }),
    ).resolves.toMatchObject({ ok: true });
    // A reader touches the path before the eviction commits.
    now(6000);
    await shard.lookup(HASH);
    await expect(shard.commit('evict-race')).resolves.toMatchObject({
      ok: false,
      error: { code: 'path_in_use', status: 409 },
    });
    expect(operationStatus(db, 'evict-race')).toBe('ABORTED');
    expect(lastAccessed(db, HASH)).toBe(6000);
    await expect(shard.commit('evict-race')).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation_aborted' },
    });
  });

  it('still commits a delete without a guard after a lookup', async () => {
    const { db, shard } = setupShard();
    insertPath(db, { store_hash: HASH, last_accessed: 1000 });
    now(2000);
    await expect(
      shard.prepare({
        operation_id: 'delete-plain',
        mutation: { kind: 'delete', store_hash: HASH },
      }),
    ).resolves.toMatchObject({ ok: true });
    now(6000);
    await shard.lookup(HASH);
    await expect(shard.commit('delete-plain')).resolves.toMatchObject({
      ok: true,
      value: { status: 'COMMITTED' },
    });
    expect(
      db
        .prepare('SELECT COUNT(*) AS value FROM paths WHERE store_hash = ?')
        .get(HASH) as { value: number },
    ).toMatchObject({ value: 0 });
  });
});

describe('pruning old operations', () => {
  it('lists only settled operations with a path', async () => {
    const { db, shard } = setupShard();
    now(10_000);
    const entry = record({ store_hash: HASH });
    await shard.prepare({
      operation_id: 'op-prepared',
      mutation: { kind: 'upsert', record: entry },
    });
    await shard.prepare({
      operation_id: 'op-committed',
      mutation: {
        kind: 'upsert',
        record: record({ store_hash: 'b'.repeat(32) }),
      },
    });
    await shard.commit('op-committed');
    await shard.prepare({
      operation_id: 'op-aborted',
      mutation: {
        kind: 'upsert',
        record: record({ store_hash: 'c'.repeat(32) }),
      },
    });
    await shard.abort('op-aborted');
    expect(operationStatus(db, 'op-prepared')).toBe('PREPARED');

    const stale = await shard.staleOperations({
      before: 20_000,
      after: null,
      limit: 100,
    });
    expect(stale).toMatchObject({ ok: true });
    if (!stale.ok) throw new Error('expected stale operations');
    expect(stale.value.operation_ids.sort()).toEqual([
      'op-aborted',
      'op-committed',
    ]);
    expect(stale.value.next_after).toBeNull();
  });

  it('never lists the record of a cache clear', async () => {
    const { shard } = setupShard();
    now(10_000);
    await shard.prepare({
      operation_id: 'op-committed',
      mutation: {
        kind: 'upsert',
        record: record({ store_hash: HASH }),
      },
    });
    await shard.commit('op-committed');
    await shard.clear('clear-op');

    const stale = await shard.staleOperations({
      before: 20_000,
      after: null,
      limit: 100,
    });
    if (!stale.ok) throw new Error('expected stale operations');
    expect(stale.value.operation_ids).toEqual(['op-committed']);
  });

  it('pages through stale operations', async () => {
    const { shard } = setupShard();
    now(10_000);
    for (const id of ['op-a', 'op-b', 'op-c']) {
      await shard.prepare({
        operation_id: id,
        mutation: {
          kind: 'upsert',
          record: record({ store_hash: `${id}-hash`.padEnd(32, '0') }),
        },
      });
      await shard.commit(id);
    }
    const first = await shard.staleOperations({
      before: 20_000,
      after: null,
      limit: 2,
    });
    if (!first.ok) throw new Error('expected stale operations');
    expect(first.value.operation_ids).toEqual(['op-a', 'op-b']);
    expect(first.value.next_after).toBe('op-b');
    const second = await shard.staleOperations({
      before: 20_000,
      after: first.value.next_after,
      limit: 2,
    });
    if (!second.ok) throw new Error('expected stale operations');
    expect(second.value.operation_ids).toEqual(['op-c']);
    expect(second.value.next_after).toBeNull();
  });

  it('counts a missing created_at as old', async () => {
    const { db, shard } = setupShard();
    now(10_000);
    await shard.prepare({
      operation_id: 'op-new',
      mutation: {
        kind: 'upsert',
        record: record({ store_hash: HASH }),
      },
    });
    await shard.commit('op-new');
    db.prepare(
      "INSERT INTO index_operations (operation_id, store_hash, mutation, delta, status, created_at) VALUES (?, ?, ?, ?, 'COMMITTED', NULL)",
    ).run(
      'op-legacy',
      HASH,
      JSON.stringify({ kind: 'delete', store_hash: HASH }),
      0,
    );

    const stale = await shard.staleOperations({
      before: 0,
      after: null,
      limit: 100,
    });
    if (!stale.ok) throw new Error('expected stale operations');
    expect(stale.value.operation_ids).toEqual(['op-legacy']);
  });

  it('never forgets a prepared row', async () => {
    const { db, shard } = setupShard();
    now(10_000);
    await shard.prepare({
      operation_id: 'op-prepared',
      mutation: { kind: 'upsert', record: record({ store_hash: HASH }) },
    });
    await shard.prepare({
      operation_id: 'op-committed',
      mutation: {
        kind: 'upsert',
        record: record({ store_hash: 'b'.repeat(32) }),
      },
    });
    await shard.commit('op-committed');

    await shard.forgetOperations({
      operation_ids: ['op-prepared', 'op-committed', 'missing'],
    });

    expect(operationStatus(db, 'op-prepared')).toBe('PREPARED');
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS value FROM index_operations WHERE operation_id = ?',
        )
        .get('op-committed') as { value: number },
    ).toMatchObject({ value: 0 });
  });

  it('never forgets the record of a cache clear', async () => {
    const { db, shard } = setupShard();
    now(10_000);
    insertPath(db, { store_hash: HASH, file_size: 100 });
    await shard.prepare({
      operation_id: 'op-committed',
      mutation: {
        kind: 'upsert',
        record: record({ store_hash: 'b'.repeat(32), file_size: 50 }),
      },
    });
    await shard.commit('op-committed');
    await shard.clear('clear-op');

    await shard.forgetOperations({
      operation_ids: ['op-committed', 'clear-op'],
    });

    // The clear record survives, so a retried clear reports the same totals.
    await expect(shard.clear('clear-op')).resolves.toMatchObject({
      ok: true,
      value: { deleted: 2, bytes: 150 },
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
