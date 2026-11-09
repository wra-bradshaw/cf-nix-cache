import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { RpcResult } from '../../../shared/rpc';
import { INFLIGHT_SCHEMA, UploadAllocations } from './upload-allocations';

function allocations(): UploadAllocations & { db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE cache (lifecycle TEXT NOT NULL);
    INSERT INTO cache VALUES ('ACTIVE');
    CREATE TABLE upload_allocations (
      operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, upload_id TEXT NOT NULL UNIQUE, staging_key TEXT NOT NULL, created_at INTEGER
    );
    ${INFLIGHT_SCHEMA}`);
  let next = 0;
  const ctx = {
    storage: {
      sql: {
        exec: (query: string, ...args: unknown[]) =>
          db.prepare(query).all(...(args as string[])),
      },
      transactionSync: <T>(body: () => T): T => body(),
    },
  } as unknown as DurableObjectState;
  const env = {
    UPLOAD_JOB: { newUniqueId: () => ({ toString: () => `job${next++}` }) },
  } as unknown as Env;
  return Object.assign(new UploadAllocations(ctx, env), { db });
}

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

const request = (operation_id: string, nar_hash = 'nar-a', now = 1000) => ({
  operation_id,
  fingerprint: `${operation_id}:${nar_hash}`,
  store_hash: 'store',
  nar_hash,
  now,
  merge: true,
});

describe('in-flight uploads', () => {
  it('joins a second push of the same NAR to the first upload', async () => {
    const ledger = allocations();
    const first = value(await ledger.allocate(request('a')));
    const second = value(await ledger.allocate(request('b')));
    expect(first).toMatchObject({ id: 'job0', merged: false });
    expect(second).toMatchObject({ id: 'job0', merged: true });
    expect(
      value(
        await ledger.pending({ store_hashes: ['store', 'other'], now: 1000 }),
      ),
    ).toEqual([{ store_hash: 'store', upload_id: 'job0' }]);
  });

  it('keeps the idempotent retry of a key', async () => {
    const ledger = allocations();
    value(await ledger.allocate(request('a')));
    expect(value(await ledger.allocate(request('a')))).toMatchObject({
      id: 'job0',
      repeated: true,
      merged: false,
    });
  });

  it('starts a new upload for a different NAR hash, which takes over', async () => {
    const ledger = allocations();
    value(await ledger.allocate(request('a')));
    const replacement = value(await ledger.allocate(request('b', 'nar-b')));
    expect(replacement).toMatchObject({ id: 'job1', merged: false });
    expect(value(await ledger.allocate(request('c', 'nar-b')))).toMatchObject({
      id: 'job1',
      merged: true,
    });
  });

  it('lets a push replace a failed upload, or one that has been released', async () => {
    const ledger = allocations();
    value(await ledger.allocate(request('a')));
    const replaced = value(
      await ledger.allocate({ ...request('b'), replace: 'job0' }),
    );
    expect(replaced).toMatchObject({ id: 'job1', merged: false });
    value(await ledger.release({ store_hash: 'store', upload_id: 'job1' }));
    expect(value(await ledger.allocate(request('c')))).toMatchObject({
      id: 'job2',
      merged: false,
    });
  });

  it('does not join when the caller cannot, or after the entry expires', async () => {
    const ledger = allocations();
    value(await ledger.allocate(request('a')));
    expect(
      value(await ledger.allocate({ ...request('b'), merge: false })),
    ).toMatchObject({ id: 'job1', merged: false });
    expect(value(await ledger.allocate(request('c')))).toMatchObject({
      id: 'job0',
      merged: true,
    });
    expect(
      value(await ledger.allocate(request('d', 'nar-a', 1000 + 3600))),
    ).toMatchObject({ id: 'job2', merged: false });
  });
});

describe('pruning old allocations', () => {
  it('lists allocations older than the cutoff, newest first by id', async () => {
    const ledger = allocations();
    value(await ledger.allocate(request('a', 'nar-a', 1000)));
    value(await ledger.allocate(request('b', 'nar-b', 2000)));
    value(await ledger.allocate(request('c', 'nar-c', 3000)));
    expect(
      value(await ledger.stale({ before: 2500, after: null, limit: 10 })),
    ).toEqual({ upload_ids: ['job0', 'job1'], next_after: null });
  });

  it('pages through stale allocations', async () => {
    const ledger = allocations();
    for (let index = 0; index < 3; index += 1)
      value(
        await ledger.allocate({
          ...request(`op${index}`, `nar-${index}`, 1000),
          store_hash: `store${index}`,
        }),
      );
    expect(
      value(await ledger.stale({ before: 5000, after: null, limit: 2 })),
    ).toEqual({ upload_ids: ['job0', 'job1'], next_after: 'job1' });
    expect(
      value(await ledger.stale({ before: 5000, after: 'job1', limit: 2 })),
    ).toEqual({ upload_ids: ['job2'], next_after: null });
  });

  it('treats a missing created_at as old', async () => {
    const ledger = allocations();
    value(await ledger.allocate(request('a', 'nar-a', 9000)));
    ledger.db
      .prepare(
        'INSERT INTO upload_allocations (operation_id, fingerprint, upload_id, staging_key, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        'legacy',
        'legacy',
        'job-legacy',
        'staging/job-legacy.chunks.json',
        null,
      );
    expect(
      value(await ledger.stale({ before: 100, after: null, limit: 10 })),
    ).toEqual({ upload_ids: ['job-legacy'], next_after: null });
  });

  it('forgets only the given upload ids', async () => {
    const ledger = allocations();
    value(await ledger.allocate(request('a')));
    value(await ledger.allocate({ ...request('b'), store_hash: 'other' }));
    value(await ledger.forget({ upload_ids: ['job0'] }));
    expect(
      value(await ledger.stale({ before: 5000, after: null, limit: 10 })),
    ).toEqual({ upload_ids: ['job1'], next_after: null });
  });

  it('rejects an invalid limit or before', async () => {
    const ledger = allocations();
    expect(
      await ledger.stale({ before: 5000, after: null, limit: 0 }),
    ).toMatchObject({ ok: false });
    expect(
      await ledger.stale({ before: NaN, after: null, limit: 10 }),
    ).toMatchObject({ ok: false });
  });
});
