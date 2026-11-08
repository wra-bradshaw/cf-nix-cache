import type { GcActiveRun, GcPhase, GcSummary } from '../types';
import { type RpcResult, failure, ok } from '../../../shared/rpc';
import { first, type SqlRow, integer, json, text } from '../../../shared/sql';

export const RUN_TTL_SECONDS = 30 * 60;
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

// Leases cover dedup-reused objects with no new write; deletion waits for gate + lease drain.
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
          // Upsert so late marks still read as processed.
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

  // DESC deletes manifests before chunks.
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

  finish(summary: GcSummary): RpcResult<void> {
    return this.transaction(() => {
      let run: SqlRow | undefined;
      try {
        run = this.row();
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

  // Invalid lease means objects may have been swept; reprocess.
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

  // Corrupt rows read as missing with corrupt:true; gate still fails closed.
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
      corrupt = true;
      console.warn({
        message: 'ignoring corrupt garbage collection run record',
        error: error instanceof Error ? error.message : error,
      });
      run = undefined;
    }
    const lastRow = (() => {
      try {
        const row = first(
          this.sql.exec<SqlRow>(
            'SELECT summary FROM gc_last_run WHERE key = 1',
          ),
        );
        if (!row) return undefined;
        return json<GcSummary>(row, 'summary');
      } catch (error) {
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
  if (value === 1) return true;
  if (value === 0) return false;
  throw new Error(`gc dry_run flag ${value} is not 0 or 1`);
}
