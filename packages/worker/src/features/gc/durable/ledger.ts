import type { GcActiveRun, GcPhase, GcSummary } from '../types';
import { type RpcResult, failure, ok } from '../../../shared/rpc';
import { first, type SqlRow } from '../../../shared/sql';

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
  exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: unknown[]
  ): Iterable<T>;
}

/**
 * Coordinates mark-and-sweep with uploads.
 *
 * Content-addressed writes are deduplicated: a processor that finds a chunk or
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
    return run && Number(run.deadline) > now ? run : undefined;
  }

  /** Validates the caller still owns the run, and extends its deadline. */
  private owned(
    runId: string,
    now: number,
  ): RpcResult<{ phase: GcPhase; dry_run: boolean }> {
    const run = this.liveRun(now);
    if (!run || run.run_id !== runId)
      return failure('gc_superseded', 'garbage collection run lost', 409);
    this.sql.exec(
      'UPDATE gc_run SET deadline = ? WHERE key = 1',
      now + RUN_TTL_SECONDS,
    );
    return ok({
      phase: String(run.phase) as GcPhase,
      dry_run: Number(run.dry_run) === 1,
    });
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
      const live = this.liveRun(input.now);
      if (live) {
        if (live.run_id !== input.run_id) return ok({ started: false });
        return ok({ started: true });
      }
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
      for (const key of input.keys)
        this.sql.exec(
          'INSERT OR IGNORE INTO gc_marks (key, expanded) VALUES (?, 0)',
          key,
        );
      return ok();
    });
  }

  pendingManifests(input: {
    run_id: string;
    limit: number;
    now: number;
  }): RpcResult<string[]> {
    return this.transaction(() => {
      const owned = this.owned(input.run_id, input.now);
      if (!owned.ok) return owned;
      return ok(
        [
          ...this.sql.exec<{ key: string }>(
            'SELECT key FROM gc_marks WHERE expanded = 0 LIMIT ?',
            input.limit,
          ),
        ].map((row) => String(row.key)),
      );
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
      for (const manifest of input.manifests) {
        for (const key of manifest.chunk_keys)
          this.sql.exec(
            'INSERT INTO gc_marks (key, expanded) VALUES (?, 1) ON CONFLICT (key) DO UPDATE SET expanded = 1',
            key,
          );
        this.sql.exec(
          'UPDATE gc_marks SET expanded = 1 WHERE key = ?',
          manifest.key,
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
      for (const object of input.objects)
        this.sql.exec(
          'INSERT OR REPLACE INTO gc_candidates (key, size) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM gc_marks WHERE key = ?)',
          object.key,
          object.size,
          object.key,
        );
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
        this.sql.exec<{ objects: number; bytes: number }>(
          'SELECT COUNT(*) AS objects, COALESCE(SUM(size), 0) AS bytes FROM gc_candidates c WHERE NOT EXISTS (SELECT 1 FROM gc_marks m WHERE m.key = c.key)',
        ),
      );
      const marked = first(
        this.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM gc_marks',
        ),
      );
      return ok({
        objects: Number(totals?.objects ?? 0),
        bytes: Number(totals?.bytes ?? 0),
        marked: Number(marked?.count ?? 0),
      });
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
      this.retireExpiredLeases(input.now);
      const active = first(
        this.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM gc_leases',
        ),
      );
      const drained = Number(active?.count ?? 0) === 0;
      this.sql.exec(
        'UPDATE gc_run SET phase = ? WHERE key = 1',
        drained ? 'SWEEP' : 'DRAIN',
      );
      return ok({ drained });
    });
  }

  /**
   * The next objects that are safe to delete. Ordered descending so that
   * `manifests/` precede `chunks/`: an interrupted sweep must never leave a
   * manifest whose chunks are gone, because a later upload of that NAR would
   * trust the manifest and publish a path that cannot be served.
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
      return ok(
        [
          ...this.sql.exec<{ key: string; size: number }>(
            'SELECT c.key AS key, c.size AS size FROM gc_candidates c WHERE NOT EXISTS (SELECT 1 FROM gc_marks m WHERE m.key = c.key) ORDER BY c.key DESC LIMIT ?',
            input.limit,
          ),
        ].map((row) => ({ key: String(row.key), size: Number(row.size) })),
      );
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
      for (const key of input.keys)
        this.sql.exec('DELETE FROM gc_candidates WHERE key = ?', key);
      return ok();
    });
  }

  /** Ends the run, opens the gate and records the summary. */
  finish(summary: GcSummary): RpcResult<void> {
    return this.transaction(() => {
      const run = this.row();
      // A superseded run must not disturb the run that replaced it.
      if (run?.run_id !== summary.run_id) return ok();
      this.sql.exec('DELETE FROM gc_run WHERE key = 1');
      this.resetWorkingTables();
      this.sql.exec(
        'INSERT OR REPLACE INTO gc_last_run (key, summary) VALUES (1, ?)',
        JSON.stringify(summary),
      );
      return ok();
    });
  }

  acquireLease(input: {
    job_id: string;
    token: string;
    now: number;
  }): RpcResult<{ granted: boolean }> {
    return this.transaction(() => {
      const run = this.liveRun(input.now);
      if (run && run.phase !== 'MARK') return ok({ granted: false });
      this.sql.exec(
        'INSERT INTO gc_leases (job_id, token, expires_at) VALUES (?, ?, ?) ON CONFLICT (job_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at',
        input.job_id,
        input.token,
        input.now + LEASE_TTL_SECONDS,
      );
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
      const lease = first(
        this.sql.exec<SqlRow>(
          'SELECT token, expires_at FROM gc_leases WHERE job_id = ?',
          input.job_id,
        ),
      );
      if (
        !lease ||
        lease.token !== input.token ||
        Number(lease.expires_at) <= input.now
      )
        return ok({ valid: false });
      this.sql.exec(
        'UPDATE gc_leases SET expires_at = ?, manifest_key = ? WHERE job_id = ?',
        input.now + LEASE_TTL_SECONDS,
        input.manifest_key,
        input.job_id,
      );
      if (this.liveRun(input.now))
        this.sql.exec(
          'INSERT OR IGNORE INTO gc_marks (key, expanded) VALUES (?, 0)',
          input.manifest_key,
        );
      return ok({ valid: true });
    });
  }

  releaseLease(input: { job_id: string; token: string }): RpcResult<void> {
    return this.transaction(() => {
      this.sql.exec(
        'DELETE FROM gc_leases WHERE job_id = ? AND token = ?',
        input.job_id,
        input.token,
      );
      return ok();
    });
  }

  status(now: number): {
    active_run?: GcActiveRun;
    last_run?: GcSummary;
  } {
    const run = this.liveRun(now);
    const last = first(
      this.sql.exec<{ summary: string }>(
        'SELECT summary FROM gc_last_run WHERE key = 1',
      ),
    );
    return {
      ...(run
        ? {
            active_run: {
              run_id: String(run.run_id),
              phase: String(run.phase) as GcPhase,
              started_at: Number(run.started_at),
              dry_run: Number(run.dry_run) === 1,
            },
          }
        : {}),
      ...(last ? { last_run: JSON.parse(last.summary) as GcSummary } : {}),
    };
  }
}
