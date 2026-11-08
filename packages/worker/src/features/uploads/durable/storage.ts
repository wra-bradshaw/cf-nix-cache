import type { UploadManifest, UploadState } from '../types';
import type { ProcessReceipt, UploadRow } from './upload-row';
import { first, type SqlRow } from '../../../shared/sql';

// `staging_key` holds the upload's chunk list key. `upload_id` and `parts`
// belonged to staging uploads, which were removed; new rows leave them empty.
const schema = `CREATE TABLE IF NOT EXISTS job (
  job_id TEXT PRIMARY KEY, cache TEXT NOT NULL, cache_id TEXT NOT NULL, incarnation TEXT NOT NULL,
  staging_key TEXT NOT NULL, upload_id TEXT, state TEXT NOT NULL, manifest TEXT NOT NULL,
  compressed_size INTEGER NOT NULL, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  parts TEXT NOT NULL, error TEXT, result TEXT
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
        'SELECT job_id, cache, cache_id, incarnation, staging_key, state, manifest, compressed_size, idempotency_key, fingerprint, error, result FROM job LIMIT 1',
      ),
    );
    if (!row) return null;
    const session = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT key FROM session WHERE key = 1',
      ),
    );
    return {
      job_id: String(row.job_id),
      cache: String(row.cache),
      cache_id: String(row.cache_id),
      incarnation: String(row.incarnation),
      chunks_key: String(row.staging_key),
      encoded: Boolean(session),
      state: String(row.state) as UploadState,
      manifest: JSON.parse(String(row.manifest)) as UploadManifest,
      compressed_size: Number(row.compressed_size),
      idempotency_key: String(row.idempotency_key),
      fingerprint: String(row.fingerprint),
      error: row.error ? String(row.error) : null,
      result: row.result
        ? (JSON.parse(String(row.result)) as ProcessReceipt)
        : null,
    };
  }

  insert(input: {
    job_id: string;
    cache: string;
    cache_id: string;
    incarnation: string;
    chunks_key: string;
    manifest: UploadManifest;
    compressed_size: number;
    idempotency_key: string;
    fingerprint: string;
  }): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (this.row()) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO job (job_id, cache, cache_id, incarnation, staging_key, upload_id, state, manifest, compressed_size, idempotency_key, fingerprint, parts) VALUES (?, ?, ?, ?, ?, NULL, 'UPLOADING', ?, ?, ?, ?, '{}')",
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
      return true;
    });
  }

  setQueued(jobId: string): void {
    this.ctx.storage.transactionSync(() =>
      this.ctx.storage.sql.exec(
        "UPDATE job SET state = 'QUEUED' WHERE job_id = ? AND state = 'COMPLETING'",
        jobId,
      ),
    );
  }

  setState(jobId: string, from: UploadState[], to: UploadState): void {
    this.ctx.storage.transactionSync(() =>
      this.ctx.storage.sql.exec(
        `UPDATE job SET state = ? WHERE job_id = ? AND state IN (${from.map(() => '?').join(', ')})`,
        to,
        jobId,
        ...from,
      ),
    );
  }

  /** Returns the stored receipt, whose `published_at` the first attempt set. */
  setResult(
    jobId: string,
    result: ProcessReceipt,
    from: UploadState[],
    to: UploadState,
  ): ProcessReceipt {
    return this.ctx.storage.transactionSync(() => {
      const receipt = {
        ...result,
        published_at: this.row()?.result?.published_at ?? result.published_at,
      };
      this.ctx.storage.sql.exec(
        `UPDATE job SET state = ?, result = ? WHERE job_id = ? AND state IN (${from.map(() => '?').join(', ')})`,
        to,
        JSON.stringify(receipt),
        jobId,
        ...from,
      );
      return receipt;
    });
  }

  setError(jobId: string, message: string, to: UploadState = 'FAILED'): void {
    this.ctx.storage.transactionSync(() =>
      this.ctx.storage.sql.exec(
        'UPDATE job SET state = ?, error = ? WHERE job_id = ?',
        to,
        message.slice(0, 2000),
        jobId,
      ),
    );
  }
}
