import type { UploadManifest, UploadState } from '../../../types';
import type { ProcessReceipt, UploadRow } from './model';
import { first, type SqlRow } from '../../../infrastructure/durable/shared';

const schema = `CREATE TABLE IF NOT EXISTS job (
  job_id TEXT PRIMARY KEY, cache TEXT NOT NULL, cache_id TEXT NOT NULL, incarnation TEXT NOT NULL,
  staging_key TEXT NOT NULL, upload_id TEXT, state TEXT NOT NULL, manifest TEXT NOT NULL,
  compressed_size INTEGER NOT NULL, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  parts TEXT NOT NULL, error TEXT, result TEXT
);`;

export class UploadStorage {
  constructor(private readonly ctx: DurableObjectState) {
    ctx.storage.sql.exec(schema);
  }

  row(): UploadRow | null {
    const row = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT job_id, cache, cache_id, incarnation, staging_key, upload_id, state, manifest, compressed_size, idempotency_key, fingerprint, parts, error, result FROM job LIMIT 1',
      ),
    );
    if (!row) return null;
    return {
      job_id: String(row.job_id),
      cache: String(row.cache),
      cache_id: String(row.cache_id),
      incarnation: String(row.incarnation),
      staging_key: String(row.staging_key),
      upload_id: row.upload_id ? String(row.upload_id) : null,
      state: String(row.state) as UploadState,
      manifest: JSON.parse(String(row.manifest)) as UploadManifest,
      compressed_size: Number(row.compressed_size),
      idempotency_key: String(row.idempotency_key),
      fingerprint: String(row.fingerprint),
      parts: JSON.parse(String(row.parts)) as Record<string, string>,
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
    staging_key: string;
    upload_id: string;
    manifest: UploadManifest;
    compressed_size: number;
    idempotency_key: string;
    fingerprint: string;
  }): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (this.row()) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO job (job_id, cache, cache_id, incarnation, staging_key, upload_id, state, manifest, compressed_size, idempotency_key, fingerprint, parts) VALUES (?, ?, ?, ?, ?, ?, 'UPLOADING', ?, ?, ?, ?, ?)",
        input.job_id,
        input.cache,
        input.cache_id,
        input.incarnation,
        input.staging_key,
        input.upload_id,
        JSON.stringify(input.manifest),
        input.compressed_size,
        input.idempotency_key,
        input.fingerprint,
        '{}',
      );
      return true;
    });
  }

  setParts(jobId: string, parts: Record<string, string>): void {
    this.ctx.storage.transactionSync(() =>
      this.ctx.storage.sql.exec(
        'UPDATE job SET parts = ? WHERE job_id = ?',
        JSON.stringify(parts),
        jobId,
      ),
    );
  }

  setCompleting(jobId: string, parts: Record<string, string>): void {
    this.ctx.storage.transactionSync(() =>
      this.ctx.storage.sql.exec(
        "UPDATE job SET state = 'COMPLETING', parts = ? WHERE job_id = ? AND state = 'UPLOADING'",
        JSON.stringify(parts),
        jobId,
      ),
    );
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

  setResult(
    jobId: string,
    result: ProcessReceipt,
    from: UploadState[],
    to: UploadState,
  ): void {
    this.ctx.storage.transactionSync(() =>
      this.ctx.storage.sql.exec(
        `UPDATE job SET state = ?, result = ? WHERE job_id = ? AND state IN (${from.map(() => '?').join(', ')})`,
        to,
        JSON.stringify(result),
        jobId,
        ...from,
      ),
    );
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
