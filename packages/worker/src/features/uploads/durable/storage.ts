import type { UploadManifest, UploadState } from '../types';
import type { ChunkClaim } from '../encoding';
import type { ProcessReceipt, UploadRow } from './upload-row';
import { first, type SqlRow, text, integer, json } from '../../../shared/sql';

export type SetResultOutcome = ProcessReceipt & { wrote: boolean };

function rowsUpdated(cursor: unknown): number {
  const rowsWritten = (cursor as { rowsWritten?: unknown }).rowsWritten;
  return typeof rowsWritten === 'number' ? rowsWritten : 0;
}

const schema = `CREATE TABLE IF NOT EXISTS job (
  job_id TEXT PRIMARY KEY, cache TEXT NOT NULL, cache_id TEXT NOT NULL, incarnation TEXT NOT NULL,
  chunks_key TEXT NOT NULL, state TEXT NOT NULL, manifest TEXT NOT NULL,
  compressed_size INTEGER NOT NULL, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  error TEXT, result TEXT
);
CREATE TABLE IF NOT EXISTS session (
  key INTEGER PRIMARY KEY CHECK (key = 1), lease_token TEXT, existing_manifest INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_chunks (
  idx INTEGER PRIMARY KEY, raw_hash TEXT NOT NULL, raw_size INTEGER NOT NULL,
  compressed_hash TEXT NOT NULL, compressed_size INTEGER NOT NULL, present INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_chunks_hash ON session_chunks(raw_hash);`;

export class UploadStorage {
  constructor(private readonly ctx: DurableObjectState) {
    ctx.storage.sql.exec(schema);
  }

  row(): UploadRow | null {
    const row = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT job_id, cache, cache_id, incarnation, chunks_key, state, manifest, compressed_size, idempotency_key, fingerprint, error, result FROM job LIMIT 1',
      ),
    );
    if (!row) return null;
    const session = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT key FROM session WHERE key = 1',
      ),
    );
    return {
      job_id: text(row, 'job_id'),
      cache: text(row, 'cache'),
      cache_id: text(row, 'cache_id'),
      incarnation: text(row, 'incarnation'),
      chunks_key: text(row, 'chunks_key'),
      encoded: Boolean(session),
      state: text(row, 'state') as UploadState,
      manifest: json<UploadManifest>(row, 'manifest'),
      compressed_size: integer(row, 'compressed_size'),
      idempotency_key: text(row, 'idempotency_key'),
      fingerprint: text(row, 'fingerprint'),
      error: row.error ? text(row, 'error') : null,
      result: row.result
        ? (JSON.parse(text(row, 'result')) as ProcessReceipt)
        : null,
    };
  }

  insertOpen(
    input: {
      job_id: string;
      cache: string;
      cache_id: string;
      incarnation: string;
      chunks_key: string;
      manifest: UploadManifest;
      compressed_size: number;
      idempotency_key: string;
      fingerprint: string;
    },
    session: { leaseToken: string; existingManifest: boolean },
    chunks: Array<ChunkClaim & { present: boolean }>,
  ): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (this.row()) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO job (job_id, cache, cache_id, incarnation, chunks_key, state, manifest, compressed_size, idempotency_key, fingerprint) VALUES (?, ?, ?, ?, ?, 'UPLOADING', ?, ?, ?, ?)",
        input.job_id,
        input.cache,
        input.cache_id,
        input.incarnation,
        input.chunks_key,
        JSON.stringify(input.manifest),
        input.compressed_size,
        input.idempotency_key,
        input.fingerprint,
      );
      this.ctx.storage.sql.exec(
        'INSERT INTO session (key, lease_token, existing_manifest) VALUES (1, ?, ?)',
        session.leaseToken,
        session.existingManifest ? 1 : 0,
      );
      chunks.forEach((chunk, index) =>
        this.ctx.storage.sql.exec(
          'INSERT INTO session_chunks (idx, raw_hash, raw_size, compressed_hash, compressed_size, present) VALUES (?, ?, ?, ?, ?, ?)',
          index,
          chunk.raw_hash,
          chunk.raw_size,
          chunk.compressed_hash,
          chunk.compressed_size,
          chunk.present ? 1 : 0,
        ),
      );
      return true;
    });
  }

  setQueued(jobId: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (!row || row.state !== 'COMPLETING') return false;
      assertTransition(row.state, 'QUEUED');
      const cursor = this.ctx.storage.sql.exec(
        "UPDATE job SET state = 'QUEUED' WHERE job_id = ? AND state = 'COMPLETING'",
        jobId,
      );
      if (rowsUpdated(cursor) === 0) return false;
      return true;
    });
  }

  setState(jobId: string, from: UploadState[], to: UploadState): boolean {
    return this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (!row || !from.includes(row.state)) return false;
      assertTransition(row.state, to);
      const cursor = this.ctx.storage.sql.exec(
        `UPDATE job SET state = ? WHERE job_id = ? AND state IN (${from.map(() => '?').join(', ')})`,
        to,
        jobId,
        ...from,
      );
      if (rowsUpdated(cursor) === 0) return false;
      return true;
    });
  }

  setResult(
    jobId: string,
    result: ProcessReceipt,
    from: UploadState[],
    to: UploadState,
  ): SetResultOutcome {
    return this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (!row || !from.includes(row.state))
        return {
          ...result,
          published_at: row?.result?.published_at ?? result.published_at,
          wrote: false as const,
        };
      assertTransition(row.state, to);
      const receipt = {
        ...result,
        published_at: row.result?.published_at ?? result.published_at,
      };
      const cursor = this.ctx.storage.sql.exec(
        `UPDATE job SET state = ?, result = ? WHERE job_id = ? AND state IN (${from.map(() => '?').join(', ')})`,
        to,
        JSON.stringify(receipt),
        jobId,
        ...from,
      );
      if (rowsUpdated(cursor) === 0)
        return { ...receipt, wrote: false as const };
      return { ...receipt, wrote: true as const };
    });
  }

  setError(
    jobId: string,
    message: string,
    to: UploadState = 'FAILED',
  ): boolean {
    return this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (!row) return false;
      const allowed = (Object.keys(TRANSITIONS) as UploadState[]).filter(
        (from) => TRANSITIONS[from].includes(to),
      );
      if (!allowed.includes(row.state)) return false;
      assertTransition(row.state, to);
      const cursor = this.ctx.storage.sql.exec(
        `UPDATE job SET state = ?, error = ? WHERE job_id = ? AND state IN (${allowed.map(() => '?').join(', ')})`,
        to,
        message.slice(0, 2000),
        jobId,
        ...allowed,
      );
      if (rowsUpdated(cursor) === 0) return false;
      return true;
    });
  }
}

const TRANSITIONS: Record<string, readonly string[]> = {
  UPLOADING: ['COMPLETING', 'ABORTED', 'FAILED'],
  COMPLETING: ['QUEUED', 'PROCESSING', 'ABORTED', 'FAILED'],
  QUEUED: ['PROCESSING', 'ABORTED', 'FAILED'],
  PROCESSING: ['PUBLISHING', 'FAILED'],
  PUBLISHING: ['PUBLISHING', 'READY', 'FAILED'],
  READY: [],
  FAILED: ['FAILED'],
  ABORTED: [],
};

function assertTransition(from: UploadState, to: UploadState): void {
  if (!TRANSITIONS[from]?.includes(to))
    throw new Error(`invalid upload transition ${from} -> ${to}`);
}
