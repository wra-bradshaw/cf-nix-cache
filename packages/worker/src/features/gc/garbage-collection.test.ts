import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { shardPrefixes } from '../cache/shards';
import type { RpcResult } from '../../shared/rpc';
import { runGarbageCollection, type GcPorts } from './garbage-collection';
import { GcLedger } from './durable/ledger';
import type { GcCache, GcSteps } from './gc-ports';

const NOW = 1_000_000;
const OLD = NOW - 30 * 24 * 60 * 60;
const HASH = (prefix: string) => prefix.padEnd(32, '0');

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function realLedger(): GcLedger {
  const db = new DatabaseSync(':memory:');
  return new GcLedger(
    {
      exec: <T>(query: string, ...args: unknown[]) => {
        if (args.length === 0 && query.trimEnd().split(';').length > 2) {
          db.exec(query);
          return [] as T[];
        }
        return db.prepare(query).all(...(args as string[])) as T[];
      },
    },
    <T>(body: () => T): T => {
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
  );
}

interface Path {
  hash: string;
  manifest: string;
  last_accessed: number;
}

interface Operation {
  prefix: string;
  id: string;
  settled: boolean;
}

class World {
  readonly ledger = realLedger();
  readonly objects = new Map<string, { size: number; uploaded: number }>();
  readonly manifests = new Map<string, string[]>();
  readonly caches = new Map<GcCache, Path[]>();
  readonly deletions: string[][] = [];
  // Index and quota operation rows the catalog reports as stale.
  readonly operations: Operation[] = [];
  readonly forgottenShard: { prefix: string; ids: string[] }[] = [];
  readonly forgottenQuota: string[][] = [];
  // Upload jobs and allocation rows the catalog reports as stale.
  readonly uploads = new Map<string, { running: boolean }>();
  readonly forgottenUploads: string[][] = [];
  onStep: (name: string) => void = () => undefined;
  private clock = NOW;

  ports(run_id = 'run'): GcPorts {
    const { ledger } = this;
    const now = () => this.clock;
    return {
      ledger: {
        begin: async (input) =>
          value(ledger.begin({ ...input, run_id, now: now() })).started,
        addMarks: async (keys) =>
          value(ledger.addMarks({ run_id, keys, now: now() })),
        pendingManifests: async (limit) =>
          value(ledger.pendingManifests({ run_id, limit, now: now() })),
        expand: async (manifests) =>
          value(ledger.expand({ run_id, manifests, now: now() })),
        addCandidates: async (objects) =>
          value(ledger.addCandidates({ run_id, objects, now: now() })),
        candidateTotals: async () =>
          value(ledger.candidateTotals({ run_id, now: now() })),
        closeGate: async () =>
          value(ledger.closeGate({ run_id, now: now() })).drained,
        nextDeletions: async (limit) =>
          value(ledger.nextDeletions({ run_id, limit, now: now() })),
        markDeleted: async (keys) =>
          value(ledger.markDeleted({ run_id, keys, now: now() })),
        finish: async (summary) => value(ledger.finish(summary)),
      },
      catalog: {
        liveCaches: async () => [...this.caches.keys()],
        manifestKeys: async (cache, prefix) => ({
          keys: this.caches
            .get(cache)!
            .filter((path) => path.hash.startsWith(prefix))
            .map((path) => path.manifest),
          next_after: null,
        }),
        staleOperations: async (_cache, prefix, _before, after, limit) => {
          const ids = this.operations
            .filter(
              (operation) =>
                operation.prefix === prefix && operation.id > (after ?? ''),
            )
            .map((operation) => operation.id)
            .sort()
            .slice(0, limit);
          return {
            operation_ids: ids,
            next_after: ids.length === limit ? ids.at(-1)! : null,
          };
        },
        settledOperations: async (_cache, operationIds) =>
          operationIds.filter(
            (id) =>
              this.operations.find((operation) => operation.id === id)
                ?.settled ?? true,
          ),
        forgetShardOperations: async (_cache, prefix, operationIds) => {
          this.forgottenShard.push({ prefix, ids: operationIds });
          for (const id of operationIds) {
            const index = this.operations.findIndex(
              (operation) => operation.prefix === prefix && operation.id === id,
            );
            if (index >= 0) this.operations.splice(index, 1);
          }
        },
        forgetQuotaOperations: async (_cache, operationIds) => {
          this.forgottenQuota.push(operationIds);
        },
        staleUploads: async (_cache, _before, after, limit) => {
          const ids = [...this.uploads.keys()]
            .filter((id) => id > (after ?? ''))
            .sort()
            .slice(0, limit);
          return {
            upload_ids: ids,
            next_after: ids.length === limit ? ids.at(-1)! : null,
          };
        },
        purgeUpload: async (uploadId) => {
          const upload = this.uploads.get(uploadId)!;
          if (upload.running) return false;
          this.uploads.delete(uploadId);
          return true;
        },
        forgetUploads: async (_cache, uploadIds) => {
          this.forgottenUploads.push(uploadIds);
        },
      },
      objects: {
        manifestChunks: async (key) => this.manifests.get(key) ?? null,
        list: async (prefix) => ({
          objects: [...this.objects]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, object]) => ({ key, ...object })),
          cursor: null,
        }),
        delete: async (keys) => {
          this.deletions.push(keys);
          for (const key of keys) this.objects.delete(key);
        },
      },
    };
  }

  steps(): GcSteps {
    return {
      do: async (name, body) => {
        this.onStep(name);
        return body();
      },
      sleep: async () => {
        this.onStep('sleep');
      },
    };
  }

  cache(name = 'cache'): GcCache {
    const cache = { name, incarnation: `${name}-inc` };
    this.caches.set(cache, []);
    return cache;
  }

  store(manifest: string, chunks: string[], uploaded = OLD): void {
    this.manifests.set(manifest, chunks);
    this.objects.set(manifest, { size: 1, uploaded });
    for (const chunk of chunks) this.objects.set(chunk, { size: 10, uploaded });
  }

  publish(cache: GcCache, prefix: string, manifest: string, accessed = NOW) {
    this.caches.get(cache)!.push({
      hash: HASH(prefix),
      manifest,
      last_accessed: accessed,
    });
  }

  run(job = {}, run_id = 'run') {
    return runGarbageCollection(
      { run_id, now: NOW, job },
      this.ports(run_id),
      this.steps(),
      () => NOW,
    );
  }

  assertServable(manifest: string): void {
    expect(this.objects.has(manifest)).toBe(true);
    for (const chunk of this.manifests.get(manifest)!)
      expect(this.objects.has(chunk)).toBe(true);
  }
}

describe('shard coverage', () => {
  it('walks every shard a store hash can land in', () => {
    const prefixes = new Set(shardPrefixes());
    expect(prefixes.size).toBe(1024);
    expect(prefixes.has('zz')).toBe(true);
    expect(prefixes.has('0g')).toBe(true);
    expect(prefixes.has('ee')).toBe(false);
  });

  it('keeps paths in shards that are not hexadecimal prefixes', async () => {
    const world = new World();
    const cache = world.cache();
    world.store('manifests/m', ['chunks/c']);
    world.publish(cache, 'zy', 'manifests/m');
    await world.run();
    world.assertServable('manifests/m');
  });
});

describe('garbage collection', () => {
  it('deletes only what no cache references, manifests first', async () => {
    const world = new World();
    const cache = world.cache();
    world.store('manifests/live', ['chunks/live', 'chunks/shared']);
    world.store('manifests/dead', ['chunks/dead', 'chunks/shared']);
    world.publish(cache, 'ab', 'manifests/live');

    const summary = await world.run();

    world.assertServable('manifests/live');
    expect([...world.objects.keys()].sort()).toEqual([
      'chunks/live',
      'chunks/shared',
      'manifests/live',
    ]);
    expect(world.deletions.flat()).toEqual(['manifests/dead', 'chunks/dead']);
    expect(summary).toMatchObject({
      outcome: 'success',
      deleted_objects: 2,
      deleted_bytes: 11,
    });
  });

  it('keeps objects shared with another cache', async () => {
    const world = new World();
    const first = world.cache('first');
    const second = world.cache('second');
    world.store('manifests/m', ['chunks/c']);
    world.publish(first, 'aa', 'manifests/m');
    world.publish(second, 'bb', 'manifests/m');
    world.caches.set(first, []);
    await world.run();
    world.assertServable('manifests/m');
  });

  it('never touches staging or unrelated objects', async () => {
    const world = new World();
    world.objects.set('staging/u.nar.zst', { size: 1, uploaded: OLD });
    world.objects.set('other', { size: 1, uploaded: OLD });
    await world.run();
    expect(world.objects.size).toBe(2);
  });

  it('honours the grace period', async () => {
    const world = new World();
    world.store('manifests/recent', ['chunks/recent'], NOW - 60);
    await world.run();
    expect(world.objects.size).toBe(2);
    await world.run({ grace_seconds: 0 }, 'second');
    expect(world.objects.size).toBe(0);
  });

  it('changes nothing in a dry run, and reports what it would do', async () => {
    const world = new World();
    const cache = world.cache();
    world.store('manifests/old', ['chunks/old']);
    world.publish(cache, 'ab', 'manifests/old', OLD);
    world.store('manifests/dead', ['chunks/dead']);

    const summary = await world.run({ dry_run: true });

    expect(world.deletions).toEqual([]);
    expect(world.caches.get(cache)).toHaveLength(1);
    expect(world.forgottenShard).toEqual([]);
    expect(world.forgottenQuota).toEqual([]);
    expect(world.forgottenUploads).toEqual([]);
    expect(summary).toMatchObject({
      dry_run: true,
      deleted_objects: 2,
    });
  });

  it('does not close the gate when there is nothing to delete', async () => {
    const world = new World();
    const cache = world.cache();
    world.store('manifests/m', ['chunks/c']);
    world.publish(cache, 'ab', 'manifests/m');
    const steps: string[] = [];
    world.onStep = (name) => steps.push(name);
    await world.run();
    expect(steps.some((name) => name.startsWith('close gate'))).toBe(false);
  });

  it('skips when another run is active', async () => {
    const world = new World();
    world.store('manifests/dead', ['chunks/dead']);
    value(world.ledger.begin({ run_id: 'other', dry_run: false, now: NOW }));
    expect(await world.run()).toEqual({ skipped: true });
    expect(world.deletions).toEqual([]);
  });
});

describe('pruning old operations', () => {
  it('forgets settled operations from the shard and the quota ledger', async () => {
    const world = new World();
    world.cache(); // Pruning runs once per live cache.
    world.operations.push(
      { prefix: 'ab', id: 'op-a', settled: true },
      { prefix: 'ab', id: 'op-b', settled: true },
    );

    await world.run();

    expect(world.forgottenShard).toEqual([
      { prefix: 'ab', ids: ['op-a', 'op-b'] },
    ]);
    expect(world.forgottenQuota).toEqual([['op-a', 'op-b']]);
    expect(world.operations).toEqual([]);
  });

  it('keeps operations whose quota row is still reserved', async () => {
    const world = new World();
    world.cache(); // Pruning runs once per live cache.
    world.operations.push(
      { prefix: 'ab', id: 'op-reserved', settled: false },
      { prefix: 'ab', id: 'op-settled', settled: true },
    );

    await world.run();

    expect(world.forgottenShard).toEqual([
      { prefix: 'ab', ids: ['op-settled'] },
    ]);
    expect(world.forgottenQuota).toEqual([['op-settled']]);
    expect(world.operations.map((operation) => operation.id)).toEqual([
      'op-reserved',
    ]);
  });

  it('forgets nothing in a dry run', async () => {
    const world = new World();
    world.cache(); // Pruning runs once per live cache.
    world.operations.push({ prefix: 'ab', id: 'op-a', settled: true });
    world.uploads.set('upload-a', { running: false });

    await world.run({ dry_run: true });

    expect(world.forgottenShard).toEqual([]);
    expect(world.forgottenQuota).toEqual([]);
    expect(world.forgottenUploads).toEqual([]);
    expect(world.uploads.has('upload-a')).toBe(true);
    expect(world.operations).toHaveLength(1);
  });
});

describe('pruning old uploads', () => {
  it('purges a finished upload and forgets its allocation', async () => {
    const world = new World();
    world.cache(); // Pruning runs once per live cache.
    world.uploads.set('upload-a', { running: false });

    await world.run();

    expect(world.uploads.has('upload-a')).toBe(false);
    expect(world.forgottenUploads).toEqual([['upload-a']]);
  });

  it('keeps an upload that is still running', async () => {
    const world = new World();
    world.cache(); // Pruning runs once per live cache.
    world.uploads.set('upload-running', { running: true });
    world.uploads.set('upload-done', { running: false });

    await world.run();

    expect(world.uploads.has('upload-running')).toBe(true);
    expect(world.forgottenUploads).toEqual([['upload-done']]);
  });
});

describe('races with uploads', () => {
  it('keeps objects an upload reused after the mark walk passed', async () => {
    const world = new World();
    const cache = world.cache();
    world.store('manifests/reused', ['chunks/reused']);
    world.store('manifests/dead', ['chunks/dead']);
    let published = false;
    world.onStep = (name) => {
      if (name === 'count candidates' && !published) {
        published = true;
        value(world.ledger.acquireLease({ job_id: 'j', token: 't', now: NOW }));
        value(
          world.ledger.prepublish({
            job_id: 'j',
            token: 't',
            manifest_key: 'manifests/reused',
            now: NOW,
          }),
        );
        world.publish(cache, 'cc', 'manifests/reused');
        value(world.ledger.releaseLease({ job_id: 'j', token: 't' }));
      }
    };

    await world.run();

    world.assertServable('manifests/reused');
    expect(world.objects.has('manifests/dead')).toBe(false);
  });

  it('waits for an in-flight upload before deleting', async () => {
    const world = new World();
    const cache = world.cache();
    world.store('manifests/reused', ['chunks/reused']);
    world.store('manifests/dead', ['chunks/dead']);
    value(world.ledger.acquireLease({ job_id: 'j', token: 't', now: NOW }));
    world.onStep = (name) => {
      if (name === 'sleep') {
        expect(world.deletions).toEqual([]);
        value(
          world.ledger.prepublish({
            job_id: 'j',
            token: 't',
            manifest_key: 'manifests/reused',
            now: NOW,
          }),
        );
        world.publish(cache, 'cc', 'manifests/reused');
        value(world.ledger.releaseLease({ job_id: 'j', token: 't' }));
      }
    };

    await world.run();

    world.assertServable('manifests/reused');
    expect(world.objects.has('chunks/dead')).toBe(false);
  });

  it('blocks a new upload during the sweep', async () => {
    const world = new World();
    world.store('manifests/dead', ['chunks/dead']);
    const grants: boolean[] = [];
    world.onStep = (name) => {
      if (name === 'delete 0')
        grants.push(
          value(
            world.ledger.acquireLease({ job_id: 'j', token: 't', now: NOW }),
          ).granted,
        );
    };
    await world.run();
    expect(grants).toEqual([false]);
    expect(
      value(world.ledger.acquireLease({ job_id: 'j', token: 't', now: NOW }))
        .granted,
    ).toBe(true);
  });
});

describe('failure', () => {
  it('deletes nothing and reopens the gate if marking fails', async () => {
    const world = new World();
    const cache = world.cache();
    world.store('manifests/live', ['chunks/live']);
    world.publish(cache, 'aa', 'manifests/live');
    const ports = world.ports();
    ports.catalog.manifestKeys = async () => {
      throw new Error('shard unavailable');
    };
    await expect(
      runGarbageCollection(
        { run_id: 'run', now: NOW, job: {} },
        ports,
        world.steps(),
        () => NOW,
      ),
    ).rejects.toThrow('shard unavailable');
    expect(world.deletions).toEqual([]);
    expect(world.ledger.status(NOW).active_run).toBeUndefined();
    expect(world.ledger.status(NOW).last_run).toMatchObject({
      outcome: 'failed',
      error: 'shard unavailable',
    });
  });

  it('deletes nothing if a live manifest cannot be understood', async () => {
    const world = new World();
    const cache = world.cache();
    world.store('manifests/live', ['chunks/live']);
    world.publish(cache, 'aa', 'manifests/live');
    const ports = world.ports();
    ports.objects.manifestChunks = async () => {
      throw new Error('invalid manifest');
    };
    await expect(
      runGarbageCollection(
        { run_id: 'run', now: NOW, job: {} },
        ports,
        world.steps(),
        () => NOW,
      ),
    ).rejects.toThrow('invalid manifest');
    expect(world.deletions).toEqual([]);
    world.assertServable('manifests/live');
  });

  it('reports a live path whose manifest is already gone', async () => {
    const world = new World();
    const cache = world.cache();
    world.publish(cache, 'aa', 'manifests/gone');
    expect(await world.run()).toMatchObject({ missing_manifests: 1 });
  });

  it('finishes the sweep on a later run after dying part way', async () => {
    const world = new World();
    world.store('manifests/dead', ['chunks/dead']);
    const ports = world.ports();
    const remove = ports.objects.delete;
    ports.objects.delete = async (keys) => {
      await remove(keys.slice(0, 1));
      throw new Error('lost connection');
    };
    await expect(
      runGarbageCollection(
        { run_id: 'run', now: NOW, job: {} },
        ports,
        world.steps(),
        () => NOW,
      ),
    ).rejects.toThrow('lost connection');
    expect([...world.objects.keys()]).toEqual(['chunks/dead']);
    await world.run({}, 'second');
    expect(world.objects.size).toBe(0);
  });
});
