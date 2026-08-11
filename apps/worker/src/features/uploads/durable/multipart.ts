import {
  CompleteUploadSchema,
  parseJsonSchema,
  partsFor,
} from '../../domain/validation';
import type {
  CompleteUploadRequest,
  UploadManifest,
  UploadState,
  UploadStateResponse,
} from '../../../types';
import { ENCODING_ID, MULTIPART_PART_SIZE } from '../../../types';
import type { RpcResult } from '../../../rpc';
import { ensureWorkflow } from '../../workflows/workflow';
import { failure, processJob, state, type UploadRow } from './model';
import { UploadStorage } from './storage';

export class UploadMultipart {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly storage: UploadStorage,
  ) {}

  async init(input: {
    job_id: string;
    cache: string;
    cache_id: string;
    incarnation: string;
    staging_key: string;
    manifest: UploadManifest;
    compressed_size: number;
    idempotency_key: string;
    fingerprint: string;
  }): Promise<RpcResult<{ job_id: string; state: UploadState }>> {
    const existing = this.storage.row();
    if (existing) {
      if (
        existing.fingerprint !== input.fingerprint ||
        existing.idempotency_key !== input.idempotency_key
      )
        return failure(
          'idempotency_conflict',
          'upload metadata changed during retry',
          409,
        );
      return {
        ok: true,
        value: { job_id: existing.job_id, state: existing.state },
      };
    }
    const upload = await this.env.CACHE_BUCKET.createMultipartUpload(
      input.staging_key,
      { httpMetadata: { contentType: 'application/zstd' } },
    );
    const inserted = this.storage.insert({
      ...input,
      upload_id: upload.uploadId,
    });
    if (!inserted) {
      await this.env.CACHE_BUCKET.resumeMultipartUpload(
        input.staging_key,
        upload.uploadId,
      )
        .abort()
        .catch(() => undefined);
      const row = this.storage.row();
      return row
        ? { ok: true, value: { job_id: row.job_id, state: row.state } }
        : failure('operation_not_found', 'upload allocation disappeared', 503);
    }
    return { ok: true, value: { job_id: input.job_id, state: 'UPLOADING' } };
  }

  async putPart(input: {
    number: number;
    length: number;
    body: ReadableStream<Uint8Array> | null;
  }): Promise<RpcResult<{ part_number: number; etag: string }>> {
    const row = this.storage.row();
    if (!row?.upload_id || row.state !== 'UPLOADING')
      return failure('not_uploadable', 'upload is not accepting parts', 409);
    if (
      !Number.isSafeInteger(input.number) ||
      input.number < 1 ||
      input.number > partsFor(row.compressed_size, MULTIPART_PART_SIZE)
    )
      return failure('invalid_part', 'invalid multipart part number', 400);
    if (row.parts[input.number])
      return {
        ok: true,
        value: { part_number: input.number, etag: row.parts[input.number] },
      };
    const upload = this.env.CACHE_BUCKET.resumeMultipartUpload(
      row.staging_key,
      row.upload_id,
    );
    let part;
    if (input.body) {
      const fixed = new FixedLengthStream(input.length);
      const uploadPart = upload.uploadPart(input.number, fixed.readable);
      [part] = await Promise.all([
        uploadPart,
        input.body.pipeTo(fixed.writable),
      ]);
    } else {
      if (input.length !== 0)
        return failure('invalid_part', 'part body length does not match', 400);
      part = await upload.uploadPart(input.number, new Uint8Array());
    }
    const current = this.storage.row();
    if (current && !current.parts[input.number])
      this.storage.setParts(current.job_id, {
        ...current.parts,
        [input.number]: part.etag,
      });
    return { ok: true, value: { part_number: input.number, etag: part.etag } };
  }

  async complete(
    input: CompleteUploadRequest,
  ): Promise<RpcResult<UploadStateResponse>> {
    const supplied = parseJsonSchema(CompleteUploadSchema, input);
    const row = this.storage.row();
    if (!row?.upload_id)
      return row
        ? failure('not_uploadable', 'upload is not multipart active', 409)
        : failure('not_found', 'upload not found', 404);
    if (['QUEUED', 'PROCESSING', 'PUBLISHING'].includes(row.state)) {
      // QUEUED is persisted before workflow creation. Reconcile here as well
      // as from state() so a failed enqueue cannot strand an upload forever.
      await ensureWorkflow(
        this.env.PROCESS_UPLOAD!,
        row.job_id,
        processJob(row),
      );
      return { ok: true, value: state(this.storage.row()!) };
    }
    if (row.state === 'READY') return { ok: true, value: state(row) };
    if (row.state !== 'UPLOADING' && row.state !== 'COMPLETING')
      return { ok: true, value: state(row) };
    if (row.state === 'COMPLETING') return this.completeMultipart(row);
    const values = supplied.parts?.length
      ? supplied.parts
      : Object.entries(row.parts).map(([part_number, etag]) => ({
          part_number: Number(part_number),
          etag,
        }));
    if (!values.length)
      return failure('missing_parts', 'no uploaded parts were supplied', 400);
    const storedParts = Object.fromEntries(
      values.map((part) => [part.part_number, part.etag]),
    );
    this.storage.setCompleting(row.job_id, storedParts);
    return this.completeMultipart(this.storage.row()!);
  }

  private async completeMultipart(
    row: UploadRow,
  ): Promise<RpcResult<UploadStateResponse>> {
    const completed = await this.env.CACHE_BUCKET.head(row.staging_key);
    if (!completed) {
      if (!row.upload_id)
        return failure('not_uploadable', 'upload is not multipart active', 409);
      const parts = Object.entries(row.parts).map(([part_number, etag]) => ({
        partNumber: Number(part_number),
        etag,
      }));
      if (!parts.length)
        return failure('missing_parts', 'no uploaded parts were supplied', 400);
      await this.env.CACHE_BUCKET.resumeMultipartUpload(
        row.staging_key,
        row.upload_id,
      ).complete(parts);
    }
    return this.finishCompletion(this.storage.row()!);
  }

  private async finishCompletion(
    row: UploadRow,
  ): Promise<RpcResult<UploadStateResponse>> {
    const completed = await this.env.CACHE_BUCKET.head(row.staging_key);
    if (!completed)
      return failure(
        'completion_pending',
        'multipart completion is not yet visible',
        503,
      );
    if (completed.size !== row.compressed_size)
      return this.failSize(row, completed.size);
    this.storage.setQueued(row.job_id);
    await ensureWorkflow(this.env.PROCESS_UPLOAD!, row.job_id, {
      job_id: row.job_id,
      staging_key: row.staging_key,
      nar_hash: row.manifest.nar_hash,
      nar_size: row.manifest.nar_size,
      encoding_id: ENCODING_ID,
    });
    return { ok: true, value: state(this.storage.row()!) };
  }

  private async failSize(
    row: UploadRow,
    size: number,
  ): Promise<RpcResult<UploadStateResponse>> {
    this.storage.setError(
      row.job_id,
      `completed object size ${size} does not match declared size ${row.compressed_size}`,
    );
    await this.env.CACHE_BUCKET.delete(row.staging_key);
    return { ok: true, value: state(this.storage.row()!) };
  }
}
