import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { RpcResult } from '../../../shared/rpc';
import { GcLedger, LEASE_TTL_SECONDS, RUN_TTL_SECONDS } from './ledger';

function ledger(): GcLedger {
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

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

const summary = (run_id: string) => ({
  run_id,
  dry_run: false,
  outcome: 'success' as const,
  started_at: 1,
  finished_at: 1,
  marked_objects: 0,
  missing_manifests: 0,
  deleted_objects: 0,
  deleted_bytes: 0,
});

const run_id = 'run';
const now = 1000;

describe('upload gate', () => {
  it('waits for active leases and blocks new ones while draining', () => {
    const gc = ledger();
    value(gc.acquireLease({ job_id: 'a', token: 't', now }));
    value(gc.begin({ run_id, dry_run: false, now }));
    expect(value(gc.closeGate({ run_id, now }))).toEqual({ drained: false });
    expect(value(gc.acquireLease({ job_id: 'b', token: 't', now }))).toEqual({
      granted: false,
    });
    value(gc.releaseLease({ job_id: 'a', token: 't' }));
    expect(value(gc.closeGate({ run_id, now }))).toEqual({ drained: true });
    expect(value(gc.acquireLease({ job_id: 'b', token: 't', now }))).toEqual({
      granted: false,
    });
    value(gc.finish(summary(run_id)));
    expect(value(gc.acquireLease({ job_id: 'b', token: 't', now }))).toEqual({
      granted: true,
    });
  });

  it('allows uploads while marking', () => {
    const gc = ledger();
    value(gc.begin({ run_id, dry_run: false, now }));
    expect(value(gc.acquireLease({ job_id: 'a', token: 't', now }))).toEqual({
      granted: true,
    });
  });

  it('reopens when a run stops calling in, and fences that run', () => {
    const gc = ledger();
    value(gc.begin({ run_id, dry_run: false, now }));
    value(gc.closeGate({ run_id, now }));
    const later = now + RUN_TTL_SECONDS;
    expect(
      value(gc.acquireLease({ job_id: 'a', token: 't', now: later })),
    ).toEqual({ granted: true });
    const late = gc.nextDeletions({ run_id, limit: 10, now: later });
    expect(late.ok).toBe(false);
  });

  it('refuses to hand out deletions before the gate has drained', () => {
    const gc = ledger();
    value(gc.acquireLease({ job_id: 'a', token: 't', now }));
    value(gc.begin({ run_id, dry_run: false, now }));
    expect(gc.nextDeletions({ run_id, limit: 10, now }).ok).toBe(false);
    value(gc.closeGate({ run_id, now }));
    expect(gc.nextDeletions({ run_id, limit: 10, now }).ok).toBe(false);
  });

  it('never closes the gate for a dry run', () => {
    const gc = ledger();
    value(gc.begin({ run_id, dry_run: true, now }));
    expect(gc.closeGate({ run_id, now }).ok).toBe(false);
  });

  it('lets one run proceed at a time, and lets a retry resume', () => {
    const gc = ledger();
    expect(value(gc.begin({ run_id, dry_run: false, now })).started).toBe(true);
    expect(value(gc.begin({ run_id, dry_run: false, now })).started).toBe(true);
    expect(
      value(gc.begin({ run_id: 'other', dry_run: false, now })).started,
    ).toBe(false);
    expect(
      value(
        gc.begin({
          run_id: 'other',
          dry_run: false,
          now: now + RUN_TTL_SECONDS,
        }),
      ).started,
    ).toBe(true);
  });

  it('ignores a superseded run finishing', () => {
    const gc = ledger();
    value(gc.begin({ run_id, dry_run: false, now }));
    const later = now + RUN_TTL_SECONDS;
    value(gc.begin({ run_id: 'other', dry_run: false, now: later }));
    value(gc.finish(summary(run_id)));
    expect(gc.status(later).active_run?.run_id).toBe('other');
    expect(gc.status(later).last_run).toBeUndefined();
  });
});

describe('leases', () => {
  const manifest_key = 'manifests/e/n.json';

  it('fences an expired or replaced lease', () => {
    const gc = ledger();
    value(gc.acquireLease({ job_id: 'a', token: 't', now }));
    const publish = { job_id: 'a', token: 't', manifest_key };
    expect(
      value(gc.prepublish({ ...publish, now: now + LEASE_TTL_SECONDS })),
    ).toEqual({ valid: false });
    value(gc.acquireLease({ job_id: 'a', token: 'new', now }));
    expect(value(gc.prepublish({ ...publish, now }))).toEqual({ valid: false });
    expect(value(gc.prepublish({ ...publish, token: 'new', now }))).toEqual({
      valid: true,
    });
  });

  it('does not let an old attempt release a newer lease', () => {
    const gc = ledger();
    value(gc.acquireLease({ job_id: 'a', token: 'old', now }));
    value(gc.acquireLease({ job_id: 'a', token: 'new', now }));
    value(gc.releaseLease({ job_id: 'a', token: 'old' }));
    value(gc.begin({ run_id, dry_run: false, now }));
    expect(value(gc.closeGate({ run_id, now }))).toEqual({ drained: false });
  });

  it('marks a manifest prepublished during a run', () => {
    const gc = ledger();
    value(gc.begin({ run_id, dry_run: false, now }));
    value(gc.acquireLease({ job_id: 'a', token: 't', now }));
    value(gc.prepublish({ job_id: 'a', token: 't', manifest_key, now }));
    expect(value(gc.pendingManifests({ run_id, limit: 10, now }))).toEqual([
      manifest_key,
    ]);
  });

  it('marks a manifest prepublished just before a run started', () => {
    const gc = ledger();
    value(gc.acquireLease({ job_id: 'a', token: 't', now }));
    value(gc.prepublish({ job_id: 'a', token: 't', manifest_key, now }));
    value(gc.begin({ run_id, dry_run: false, now }));
    expect(value(gc.pendingManifests({ run_id, limit: 10, now }))).toEqual([
      manifest_key,
    ]);
  });

  it('keeps the manifest of a lease that expired mid-publication', () => {
    const gc = ledger();
    value(gc.acquireLease({ job_id: 'a', token: 't', now }));
    value(gc.prepublish({ job_id: 'a', token: 't', manifest_key, now }));
    const expired = now + LEASE_TTL_SECONDS;
    value(gc.begin({ run_id, dry_run: false, now: expired }));
    expect(value(gc.closeGate({ run_id, now: expired }))).toEqual({
      drained: true,
    });
    expect(
      value(gc.pendingManifests({ run_id, limit: 10, now: expired })),
    ).toEqual([manifest_key]);
  });
});

describe('sweep selection', () => {
  it('deletes only unmarked candidates, manifests first', () => {
    const gc = ledger();
    value(gc.begin({ run_id, dry_run: false, now }));
    value(gc.addMarks({ run_id, keys: ['manifests/live'], now }));
    value(
      gc.expand({
        run_id,
        manifests: [{ key: 'manifests/live', chunk_keys: ['chunks/live'] }],
        now,
      }),
    );
    value(
      gc.addCandidates({
        run_id,
        objects: [
          { key: 'chunks/dead', size: 3 },
          { key: 'chunks/live', size: 5 },
          { key: 'manifests/dead', size: 7 },
          { key: 'manifests/live', size: 11 },
        ],
        now,
      }),
    );
    expect(value(gc.candidateTotals({ run_id, now }))).toMatchObject({
      objects: 2,
      bytes: 10,
    });
    value(gc.closeGate({ run_id, now }));
    expect(value(gc.nextDeletions({ run_id, limit: 10, now }))).toEqual([
      { key: 'manifests/dead', size: 7 },
      { key: 'chunks/dead', size: 3 },
    ]);
    value(gc.markDeleted({ run_id, keys: ['manifests/dead'], now }));
    expect(value(gc.nextDeletions({ run_id, limit: 10, now }))).toEqual([
      { key: 'chunks/dead', size: 3 },
    ]);
  });

  it('spares a candidate that a late mark makes live', () => {
    const gc = ledger();
    value(gc.begin({ run_id, dry_run: false, now }));
    value(
      gc.addCandidates({
        run_id,
        objects: [{ key: 'chunks/c', size: 1 }],
        now,
      }),
    );
    value(
      gc.expand({
        run_id,
        manifests: [{ key: 'manifests/late', chunk_keys: ['chunks/c'] }],
        now,
      }),
    );
    value(gc.closeGate({ run_id, now }));
    expect(value(gc.nextDeletions({ run_id, limit: 10, now }))).toEqual([]);
  });

  it('starts each run with no state from the last one', () => {
    const gc = ledger();
    value(gc.begin({ run_id, dry_run: false, now }));
    value(gc.addMarks({ run_id, keys: ['manifests/old'], now }));
    value(gc.finish(summary(run_id)));
    expect(gc.status(now).active_run).toBeUndefined();
    expect(gc.status(now).last_run?.run_id).toBe(run_id);
    value(gc.begin({ run_id: 'next', dry_run: false, now }));
    expect(
      value(gc.pendingManifests({ run_id: 'next', limit: 10, now })),
    ).toEqual([]);
  });
});
