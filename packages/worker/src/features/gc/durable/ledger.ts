import type { GcActiveRun, GcPhase, GcSummary } from '../types';
import { type RpcResult, failure, ok } from '../../../shared/rpc';
import { first, type SqlRow, integer, json, text } from '../../../shared/sql';

/**
 * Longest a run may go without calling the ledger before it loses the gate.
 * A dead run can therefore block uploads for at most this long.
 */
export const RUN_TTL_SECONDS = 30 * 60;
/**
 * Must exceed the worst-case process and publish time, including step retries.
 * A lease that outlives this is fenced and its upload is processed again.
 */
export const LEASE_TTL_SECONDS = 2 * 60 * 60;

const PERMANENT_SCHEMA = `CREATE TABLE IF NOT EXISTS gc_run (
  key INTEGER PRIMARY KEY CHECK (key = 1), run_id TEXT NOT NULL, phase TEXT NOT NULL,
  deadline INTEGER NOT NULL, started_at INTEGER NOT NULL, dry_run INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gc_leases (
  job_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL, manifest_key TEXT
);
CREATE TABLE IF NOT EXISTS gc_last_run (
  key INTEGER PRIMARY KEY CHECK (key = 1), summary TEXT NOT NULL
);`;

const WORKING_SCHEMA = `CREATE TABLE IF NOT EXISTS gc_marks (
  key TEXT PRIMARY KEY, expanded INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS gc_marks_pending ON gc_marks(key) WHERE expanded = 0;
CREATE TABLE IF NOT EXISTS gc_candidates (
  key TEXT PRIMARY KEY, size INTEGER NOT NULL
) WITHOUT ROWID;`;

interface Sql {
  exec<T extends SqlRow>(query: string, ...bindings: unknown[]): Iterable<T>;
}

/**
 * Coordinates mark-and-sweep with uploads.
 *
 * Content-addressed writes are deduplicated: an upload that finds a chunk or
 * manifest already present reuses it. An unreferenced object can therefore
 * become referenced with no new write, so object age alone cannot show that it
 * is safe to delete. This ledger closes that race:
 *
 * - An upload holds a lease from before processing until after publication.
 * - A manifest about to be published is recorded on the lease and marked if a
 *   run is active, so it survives even if the mark walk has passed its shard.
 * - Deletion starts only once the gate is closed and every lease has ended. No
 *   upload can then be relying on an object it saw earlier.
 * - An expired lease fails `prepublish`, so its upload is processed again.
 */
export class GcLedger {
  constructor(
    private readonly sql: Sql,
    private readonly transaction: <T>(body: () => T) => T,
  ) {
    this.sql.exec(PERMANENT_SCHEMA);
    this.sql.exec(WORKING_SCHEMA);
  }

  private row(): SqlRow | undefined {
    return first(this.sql.exec<SqlRow>('SELECT * FROM gc_run WHERE key = 1'));
  }

  private liveRun(now: number): SqlRow | undefined {
    const run = this.row();
    return run && integer(run, 'deadline') > now ? run : undefined;
  }

  /** Validates the caller still owns the run, and extends its deadline. */
  private owned(
    runId: string,
    now: number,
  ): RpcResult<{ phase: GcPhase; dry_run: boolean }> {
    try {
      const run = this.liveRun(now);
      if (!run || text(run, 'run_id') !== runId)
        return failure('gc_superseded', 'garbage collection run lost', 409);
      this.sql.exec(
        'UPDATE gc_run SET deadline = ? WHERE key = 1',
        now + RUN_TTL_SECONDS,
      );
      return ok({
        phase: gcPhase(text(run, 'phase')),
        dry_run: dryRunFlag(integer(run, 'dry_run')),
      });
    } catch {
      return failure(
        'corrupt_gc_state',
        'garbage collection run record is corrupt',
        500,
      );
    }
  }

  private resetWorkingTables(): void {
    this.sql.exec('DROP TABLE IF EXISTS gc_marks');
    this.sql.exec('DROP TABLE IF EXISTS gc_candidates');
    this.sql.exec(WORKING_SCHEMA);
  }

  /** Marks manifests of expired leases, then removes those leases. */
  private retireExpiredLeases(now: number): void {
    this.sql.exec(
      'INSERT OR IGNORE INTO gc_marks (key, expanded) SELECT manifest_key, 0 FROM gc_leases WHERE expires_at <= ? AND manifest_key IS NOT NULL',
      now,
    );
    this.sql.exec('DELETE FROM gc_leases WHERE expires_at <= ?', now);
  }

  begin(input: {
    run_id: string;
    dry_run: boolean;
    now: number;
  }): RpcResult<{ started: boolean }> {
    return this.transaction(() => {
      let live: SqlRow | undefined;
      try {
        live = this.liveRun(input.now);
        if (live) {
          if (text(live, 'run_id') !== input.run_id)
            return ok({ started: false });
          return ok({ started: true });
        }
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection run record is corrupt',
          500,
        );
      }
      try {
        this.resetWorkingTables();
        this.sql.exec(
          "INSERT OR REPLACE INTO gc_run (key, run_id, phase, deadline, started_at, dry_run) VALUES (1, ?, 'MARK', ?, ?, ?)",
          input.run_id,
          input.now + RUN_TTL_SECONDS,
          input.now,
          input.dry_run ? 1 : 0,
        );
        // A lease that was prepublished before this run may not have committed
        // yet, so the mark walk cannot be relied on to see its manifest.
        this.sql.exec(
          'INSERT OR IGNORE INTO gc_marks (key, expanded) SELECT manifest_key, 0 FROM gc_leases WHERE manifest_key IS NOT NULL',
        );
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection run record is corrupt',
          500,
        );
      }
      return ok({ started: true });
    });
  }

  addMarks(input: {
    run_id: string;
    keys: string[];
    now: number;
  }): RpcResult<void> {
    return this.transaction(() => {
      const owned = this.owned(input.run_id, input.now);
      if (!owned.ok) return owned;
      try {
        for (const key of input.keys)
          this.sql.exec(
            'INSERT OR IGNORE INTO gc_marks (key, expanded) VALUES (?, 0)',
            key,
          );
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection mark record is corrupt',
          500,
        );
      }
      return ok();
    });
  }

  /**
   * One page of unexpanded marks for the workflow to expand.
   *
   * Internal-only walk: `limit` is a fixed constant chosen by the GC workflow
   * (MANIFESTS_PER_STEP in garbage-collection.ts), never caller-supplied HTTP
   * input. Clamp into range per the sql.ts limit policy instead of returning
   * `invalid_limit` 400; `Math.trunc(...) || 1` intentionally coerces NaN, 0,
   * and negatives to 1 rather than failing the run.
   */
  pendingManifests(input: {
    run_id: string;
    limit: number;
    now: number;
  }): RpcResult<string[]> {
    return this.transaction(() => {
      const owned = this.owned(input.run_id, input.now);
      if (!owned.ok) return owned;
      const limit = Math.min(Math.max(Math.trunc(input.limit) || 1, 1), 1000);
      try {
        return ok(
          [
            ...this.sql.exec<SqlRow>(
              'SELECT key FROM gc_marks WHERE expanded = 0 LIMIT ?',
              limit,
            ),
          ].map((row) => text(row, 'key')),
        );
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection mark record is corrupt',
          500,
        );
      }
    });
  }

  /** Records a manifest's chunks as live, and the manifest as processed. */
  expand(input: {
    run_id: string;
    manifests: { key: string; chunk_keys: string[] }[];
    now: number;
  }): RpcResult<void> {
    return this.transaction(() => {
      const owned = this.owned(input.run_id, input.now);
      if (!owned.ok) return owned;
      try {
        for (const manifest of input.manifests) {
          for (const key of manifest.chunk_keys)
            this.sql.exec(
              'INSERT INTO gc_marks (key, expanded) VALUES (?, 1) ON CONFLICT (key) DO UPDATE SET expanded = 1',
              key,
            );
          // Upsert (not a bare UPDATE): a manifest expanded without a prior
          // mark (late prepublish, recovery replay) must still read as
          // processed, otherwise a later addMarks would re-queue it as
          // unexpanded and the walk would never converge.
          this.sql.exec(
            'INSERT INTO gc_marks (key, expanded) VALUES (?, 1) ON CONFLICT (key) DO UPDATE SET expanded = 1',
            manifest.key,
          );
        }
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection mark record is corrupt',
          500,
        );
      }
      return ok();
    });
  }

  addCandidates(input: {
    run_id: string;
    objects: { key: string; size: number }[];
    now: number;
  }): RpcResult<void> {
    return this.transaction(() => {
      const owned = this.owned(input.run_id, input.now);
      if (!owned.ok) return owned;
      try {
        for (const object of input.objects)
          this.sql.exec(
            'INSERT OR REPLACE INTO gc_candidates (key, size) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM gc_marks WHERE key = ?)',
            object.key,
            object.size,
            object.key,
          );
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection candidate record is corrupt',
          500,
        );
      }
      return ok();
    });
  }

  candidateTotals(input: {
    run_id: string;
    now: number;
  }): RpcResult<{ objects: number; bytes: number; marked: number }> {
    return this.transaction(() => {
      const owned = this.owned(input.run_id, input.now);
      if (!owned.ok) return owned;
      const totals = first(
        this.sql.exec<SqlRow>(
          'SELECT COUNT(*) AS objects, COALESCE(SUM(size), 0) AS bytes FROM gc_candidates c WHERE NOT EXISTS (SELECT 1 FROM gc_marks m WHERE m.key = c.key)',
        ),
      );
      const marked = first(
        this.sql.exec<SqlRow>('SELECT COUNT(*) AS count FROM gc_marks'),
      );
      if (!totals || !marked)
        return failure(
          'corrupt_gc_state',
          'garbage collection totals are missing',
          500,
        );
      try {
        return ok({
          objects: integer(totals, 'objects'),
          bytes: integer(totals, 'bytes'),
          marked: integer(marked, 'count'),
        });
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection totals are corrupt',
          500,
        );
      }
    });
  }

  /**
   * Blocks new uploads and reports whether all active leases have ended.
   * Once this returns true, no upload can touch content-addressed objects
   * until the run finishes or expires.
   */
  closeGate(input: {
    run_id: string;
    now: number;
  }): RpcResult<{ drained: boolean }> {
    return this.transaction(() => {
      const owned = this.owned(input.run_id, input.now);
      if (!owned.ok) return owned;
      if (owned.value.dry_run)
        return failure('gc_dry_run', 'a dry run cannot close the gate', 409);
      if (owned.value.phase === 'SWEEP') return ok({ drained: true });
      try {
        this.retireExpiredLeases(input.now);
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection lease record is corrupt',
          500,
        );
      }
      const active = first(
        this.sql.exec<SqlRow>('SELECT COUNT(*) AS count FROM gc_leases'),
      );
      if (!active)
        return failure(
          'corrupt_gc_state',
          'garbage collection lease count is missing',
          500,
        );
      let drained: boolean;
      try {
        drained = integer(active, 'count') === 0;
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection lease count is corrupt',
          500,
        );
      }
      try {
        this.sql.exec(
          'UPDATE gc_run SET phase = ? WHERE key = 1',
          drained ? 'SWEEP' : 'DRAIN',
        );
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection run record is corrupt',
          500,
        );
      }
      return ok({ drained });
    });
  }

  /**
   * The next objects that are safe to delete. Ordered descending so that
   * `manifests/` precede `chunks/`: an interrupted sweep must never leave a
   * manifest whose chunks are gone, because a later upload of that NAR would
   * trust the manifest and publish a path that cannot be served.
   *
   * Internal-only walk: `limit` is a fixed constant chosen by the GC workflow
   * (R2_BATCH in garbage-collection.ts), never caller-supplied HTTP input.
   * Clamp into range per the sql.ts limit policy instead of returning
   * `invalid_limit` 400; `Math.trunc(...) || 1` intentionally coerces NaN, 0,
   * and negatives to 1 rather than failing the run.
   */
  nextDeletions(input: {
    run_id: string;
    limit: number;
    now: number;
  }): RpcResult<{ key: string; size: number }[]> {
    return this.transaction(() => {
      const owned = this.owned(input.run_id, input.now);
      if (!owned.ok) return owned;
      if (owned.value.phase !== 'SWEEP')
        return failure('gc_gate_open', 'the upload gate is not closed', 409);
      const limit = Math.min(Math.max(Math.trunc(input.limit) || 1, 1), 1000);
      try {
        return ok(
          [
            ...this.sql.exec<SqlRow>(
              'SELECT c.key AS key, c.size AS size FROM gc_candidates c WHERE NOT EXISTS (SELECT 1 FROM gc_marks m WHERE m.key = c.key) ORDER BY c.key DESC LIMIT ?',
              limit,
            ),
          ].map((row) => ({
            key: text(row, 'key'),
            size: integer(row, 'size'),
          })),
        );
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection candidate record is corrupt',
          500,
        );
      }
    });
  }

  markDeleted(input: {
    run_id: string;
    keys: string[];
    now: number;
  }): RpcResult<void> {
    return this.transaction(() => {
      const owned = this.owned(input.run_id, input.now);
      if (!owned.ok) return owned;
      try {
        for (const key of input.keys)
          this.sql.exec('DELETE FROM gc_candidates WHERE key = ?', key);
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection candidate record is corrupt',
          500,
        );
      }
      return ok();
    });
  }

  /** Ends the run, opens the gate and records the summary. */
  finish(summary: GcSummary): RpcResult<void> {
    return this.transaction(() => {
      let run: SqlRow | undefined;
      try {
        run = this.row();
        // A superseded run must not disturb the run that replaced it.
        if (!run || text(run, 'run_id') !== summary.run_id) return ok();
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection run record is corrupt',
          500,
        );
      }
      try {
        this.sql.exec('DELETE FROM gc_run WHERE key = 1');
        this.resetWorkingTables();
        this.sql.exec(
          'INSERT OR REPLACE INTO gc_last_run (key, summary) VALUES (1, ?)',
          JSON.stringify(summary),
        );
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection run record is corrupt',
          500,
        );
      }
      return ok();
    });
  }

  acquireLease(input: {
    job_id: string;
    token: string;
    now: number;
  }): RpcResult<{ granted: boolean }> {
    return this.transaction(() => {
      try {
        const run = this.liveRun(input.now);
        if (run && gcPhase(text(run, 'phase')) !== 'MARK')
          return ok({ granted: false });
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection run record is corrupt',
          500,
        );
      }
      try {
        this.sql.exec(
          'INSERT INTO gc_leases (job_id, token, expires_at) VALUES (?, ?, ?) ON CONFLICT (job_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at, manifest_key = NULL',
          input.job_id,
          input.token,
          input.now + LEASE_TTL_SECONDS,
        );
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection lease record is corrupt',
          500,
        );
      }
      return ok({ granted: true });
    });
  }

  /**
   * Must succeed immediately before a manifest is published. When it reports
   * the lease as invalid, objects seen during processing may have been swept,
   * so the upload has to be processed again.
   */
  prepublish(input: {
    job_id: string;
    token: string;
    manifest_key: string;
    now: number;
  }): RpcResult<{ valid: boolean }> {
    return this.transaction(() => {
      let lease: SqlRow | undefined;
      try {
        lease = first(
          this.sql.exec<SqlRow>(
            'SELECT token, expires_at FROM gc_leases WHERE job_id = ?',
            input.job_id,
          ),
        );
        if (
          !lease ||
          text(lease, 'token') !== input.token ||
          integer(lease, 'expires_at') <= input.now
        )
          return ok({ valid: false });
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection lease record is corrupt',
          500,
        );
      }
      try {
        this.sql.exec(
          'UPDATE gc_leases SET expires_at = ?, manifest_key = ? WHERE job_id = ?',
          input.now + LEASE_TTL_SECONDS,
          input.manifest_key,
          input.job_id,
        );
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection lease record is corrupt',
          500,
        );
      }
      try {
        if (this.liveRun(input.now))
          this.sql.exec(
            'INSERT OR IGNORE INTO gc_marks (key, expanded) VALUES (?, 0)',
            input.manifest_key,
          );
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection run record is corrupt',
          500,
        );
      }
      return ok({ valid: true });
    });
  }

  releaseLease(input: { job_id: string; token: string }): RpcResult<void> {
    return this.transaction(() => {
      try {
        this.sql.exec(
          'DELETE FROM gc_leases WHERE job_id = ? AND token = ?',
          input.job_id,
          input.token,
        );
      } catch {
        return failure(
          'corrupt_gc_state',
          'garbage collection lease record is corrupt',
          500,
        );
      }
      return ok();
    });
  }

  /**
   * Best-effort observability for `GET /api/gc`. Corrupt rows surface as
   * missing (with a warn) rather than failing the endpoint, and set
   * `corrupt: true` so a dashboard does not mistake a wedged ledger for an
   * idle one: the control plane (`begin`/`owned`) still returns
   * `corrupt_gc_state` 500 so gate safety is unaffected, and a corrupt
   * summary is overwritten by the next finished run. The shape stays
   * compatible: `corrupt` is an optional addition to `GcStatusResponse`.
   *
   * Operator runbook when `corrupt: true`:
   * - The ledger has no self-heal: a corrupt row is never auto-deleted
   *   because the gate (`begin`/`owned`) must not guess at run ownership.
   * - Corrupt summary only (`last_run` missing): no action needed; the next
   *   successful `finish()` overwrites `gc_last_run`. To clear it now,
   *   `DELETE FROM gc_last_run WHERE key = 1` inside the GcLedger
   *   transaction.
   * - Corrupt run (`active_run` missing while a run should be live, or every
   *   GC call returns `corrupt_gc_state`): inspect the warn logs for the
   *   failing column, then clear the single-row gate with
   *   `DELETE FROM gc_run WHERE key = 1` plus `DROP TABLE gc_marks` /
   *   `gc_candidates` (recreated as empty by `resetWorkingTables` on the
   *   next `begin`). Do not delete `gc_leases`: active upload leases must
   *   expire or be released, otherwise a new run could sweep objects an
   *   upload is still processing.
   */
  status(now: number): {
    active_run?: GcActiveRun;
    last_run?: GcSummary;
    corrupt?: boolean;
  } {
    let corrupt = false;
    let run: SqlRow | undefined;
    try {
      run = this.liveRun(now);
    } catch (error) {
      // A corrupt run record reads as no live run here; `begin`/`owned`
      // still reject corrupt state for the gate itself.
      corrupt = true;
      console.warn({
        message: 'ignoring corrupt garbage collection run record',
        error: error instanceof Error ? error.message : error,
      });
      run = undefined;
    }
    const lastRow = (() => {
      try {
        // The SELECT itself is inside the same try as the JSON parse: in a
        // best-effort status read a storage throw must surface as
        // corrupt:true with a warn, not escape the endpoint.
        const row = first(
          this.sql.exec<SqlRow>(
            'SELECT summary FROM gc_last_run WHERE key = 1',
          ),
        );
        if (!row) return undefined;
        return json<GcSummary>(row, 'summary');
      } catch (error) {
        // A corrupt summary must not hide the active run; it surfaces as
        // missing and is overwritten by the next finished run.
        corrupt = true;
        console.warn({
          message: 'ignoring corrupt garbage collection summary',
          error: error instanceof Error ? error.message : error,
        });
        return undefined;
      }
    })();
    let lastRun: GcSummary | undefined = lastRow;
    let activeRun: GcActiveRun | undefined;
    if (run) {
      try {
        activeRun = {
          run_id: text(run, 'run_id'),
          phase: gcPhase(text(run, 'phase')),
          started_at: integer(run, 'started_at'),
          dry_run: dryRunFlag(integer(run, 'dry_run')),
        };
      } catch (error) {
        corrupt = true;
        console.warn({
          message: 'ignoring corrupt garbage collection run record',
          error: error instanceof Error ? error.message : error,
        });
        activeRun = undefined;
      }
    }
    return {
      ...(activeRun ? { active_run: activeRun } : {}),
      ...(lastRun ? { last_run: lastRun } : {}),
      ...(corrupt ? { corrupt: true as const } : {}),
    };
  }
}

function gcPhase(value: string): GcPhase {
  if (value === 'MARK' || value === 'DRAIN' || value === 'SWEEP') return value;
  throw new Error(`gc phase ${value} is not a known phase`);
}

function dryRunFlag(value: number): boolean {
  // SQLite has no boolean type: `dry_run` is stored as 0/1. An allow-list
  // keeps a corrupt 2/-1 from coercing to false via `=== 1`; any other
  // integer throws so callers map it to `corrupt_gc_state` 500.
  if (value === 1) return true;
  if (value === 0) return false;
  throw new Error(`gc dry_run flag ${value} is not 0 or 1`);
}
