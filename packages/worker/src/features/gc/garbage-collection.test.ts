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

/** A cache installation: a real ledger over in-memory paths and objects. */
class World {
  readonly ledger = realLedger();
  readonly objects = new Map<string, { size: number; uploaded: number }>();
  readonly manifests = new Map<string, string[]>();
  readonly caches = new Map<GcCache, Path[]>();
  readonly deletions: string[][] = [];
  readonly events: string[] = [];
  readonly busy = new Set<string>();
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
        expiredPaths: async (cache, prefix, before, after, limit) => {
          const hashes = this.caches
            .get(cache)!
            .filter(
              (path) =>
                path.hash.startsWith(prefix) &&
                path.last_accessed < before &&
                path.hash > (after ?? ''),
            )
            .map((path) => path.hash)
            .sort()
            .slice(0, limit);
          return {
            hashes,
            next_after: hashes.length === limit ? hashes.at(-1)! : null,
          };
        },
        evict: async (cache, hash) => {
          if (this.busy.has(hash)) return false;
          const paths = this.caches.get(cache)!;
          this.caches.set(
            cache,
            paths.filter((path) => path.hash !== hash),
          );
          return true;
        },
        auditEviction: async (cache, _id, paths) => {
          this.events.push(`audit ${cache.name} ${paths}`);
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

  cache(retention_days = 0, name = 'cache'): GcCache {
    const cache = { name, incarnation: `${name}-inc`, retention_days };
    this.caches.set(cache, []);
    return cache;
  }

  /** Stores a manifest and chunks, as an upload would. */
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

  /** A live path's chain must be intact, or the path cannot be served. */
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
    const first = world.cache(0, 'first');
    const second = world.cache(0, 'second');
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
    const cache = world.cache(7);
    world.store('manifests/old', ['chunks/old']);
    world.publish(cache, 'ab', 'manifests/old', OLD);
    world.store('manifests/dead', ['chunks/dead']);

    const summary = await world.run({ dry_run: true });

    expect(world.deletions).toEqual([]);
    expect(world.caches.get(cache)).toHaveLength(1);
    expect(world.events).toEqual([]);
    expect(summary).toMatchObject({
      dry_run: true,
      evicted_paths: 1,
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

describe('retention', () => {
  it('evicts only expired paths, and sweeps what they alone used', async () => {
    const world = new World();
    const cache = world.cache(7);
    world.store('manifests/old', ['chunks/old', 'chunks/shared']);
    world.store('manifests/new', ['chunks/new', 'chunks/shared']);
    world.publish(cache, 'aa', 'manifests/old', OLD);
    world.publish(cache, 'bb', 'manifests/new', NOW);

    const summary = await world.run();

    expect(world.caches.get(cache)!.map((path) => path.manifest)).toEqual([
      'manifests/new',
    ]);
    world.assertServable('manifests/new');
    expect(world.objects.has('manifests/old')).toBe(false);
    expect(world.objects.has('chunks/old')).toBe(false);
    expect(summary).toMatchObject({ evicted_paths: 1 });
    expect(world.events).toEqual(['audit cache 1']);
  });

  it('leaves a cache without retention alone', async () => {
    const world = new World();
    const cache = world.cache(0);
    world.store('manifests/old', ['chunks/old']);
    world.publish(cache, 'aa', 'manifests/old', OLD);
    await world.run();
    expect(world.caches.get(cache)).toHaveLength(1);
    world.assertServable('manifests/old');
  });
});

describe('retention at scale', () => {
  const PATHS = 1203;
  const expiredInOneShard = (world: World, cache: GcCache): string[] => {
    world.store('manifests/old', ['chunks/old']);
    const hashes = Array.from(
      { length: PATHS },
      (_, index) => `ab${String(index).padStart(30, '0')}`,
    );
    world.caches.set(
      cache,
      hashes.map((hash) => ({
        hash,
        manifest: 'manifests/old',
        last_accessed: OLD,
      })),
    );
    return hashes;
  };

  it('evicts every expired path in a shard in a single run', async () => {
    const world = new World();
    const cache = world.cache(7);
    expiredInOneShard(world, cache);
    const summary = await world.run();
    expect(world.caches.get(cache)).toEqual([]);
    expect(summary).toMatchObject({ evicted_paths: PATHS });
    expect(world.events).toEqual([`audit cache ${PATHS}`]);
  });

  it('reports the exact count in a dry run', async () => {
    const world = new World();
    const cache = world.cache(7);
    expiredInOneShard(world, cache);
    const summary = await world.run({ dry_run: true });
    expect(summary).toMatchObject({ evicted_paths: PATHS });
    expect(world.caches.get(cache)).toHaveLength(PATHS);
  });

  it('passes over busy paths rather than retrying them forever', async () => {
    const world = new World();
    const cache = world.cache(7);
    const hashes = expiredInOneShard(world, cache);
    for (const hash of hashes.slice(0, 600)) world.busy.add(hash);
    const summary = await world.run();
    expect(summary).toMatchObject({
      evicted_paths: PATHS - 600,
      skipped_paths: 600,
    });
    expect(world.caches.get(cache)).toHaveLength(600);
    world.assertServable('manifests/old');
  });

  it('reaches every shard when some need several pages', async () => {
    const world = new World();
    const cache = world.cache(7);
    world.store('manifests/old', ['chunks/old']);
    const paths = shardPrefixes().map((prefix) => ({
      hash: HASH(prefix),
      manifest: 'manifests/old',
      last_accessed: OLD,
    }));
    for (let index = 0; index < 1100; index += 1)
      paths.push({
        hash: `00${String(index + 1).padStart(30, '0')}`,
        manifest: 'manifests/old',
        last_accessed: OLD,
      });
    world.caches.set(cache, paths);
    const summary = await world.run();
    expect(summary).toMatchObject({ evicted_paths: 1024 + 1100 });
    expect(world.caches.get(cache)).toEqual([]);
  });
});

describe('races with uploads', () => {
  it('keeps objects an upload reused after the mark walk passed', async () => {
    const world = new World();
    const cache = world.cache();
    // Unreferenced at the start of the run, so it is a deletion candidate.
    world.store('manifests/reused', ['chunks/reused']);
    world.store('manifests/dead', ['chunks/dead']);
    let published = false;
    world.onStep = (name) => {
      // The upload deduplicates, then publishes, once listing is under way.
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
    // Processing started before the run, and has already seen the old objects.
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
    // The manifest went first, so no surviving manifest points at a lost chunk.
    expect([...world.objects.keys()]).toEqual(['chunks/dead']);
    await world.run({}, 'second');
    expect(world.objects.size).toBe(0);
  });
});
