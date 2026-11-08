import { type RpcResult, failure, ok } from '../../../shared/rpc';
import { first, type SqlRow, text, integer } from '../../../shared/sql';
import { ensureWorkflow } from '../../../shared/workflows';
import { assertStoreHash } from '../../../shared/identifiers';
import { gcControl } from '../../gc/gc-adapters';
import {
  CHUNK_MAX_COMPRESSED_SIZE,
  CHUNK_MAX_RAW_SIZE,
  chunkKey,
  manifestKey,
  type ChunkClaim,
} from '../encoding';
import type {
  ChunkManifest,
  ProcessResult,
  UploadManifest,
  UploadState,
  UploadStateResponse,
} from '../types';
import {
  CHUNK_LIST_MAX_CHUNKS,
  chunkList,
  inlineVerifyLimit,
  MAX_NAR_SIZE,
  type StoredNar,
} from '../verify-stored';
import { assertValidRawHash } from '../verifier';
import type { UploadPublisher } from './publish';
import type { UploadStorage } from './storage';
import { toProcessJob, toStateResponse, type UploadRow } from './upload-row';

const HEAD_CONCURRENCY = 16;
const MAX_OPEN_HEADS = 1024;

export interface OpenSessionInput {
  job_id: string;
  cache: string;
  cache_id: string;
  incarnation: string;
  chunks_key: string;
  manifest: UploadManifest;
  compressed_size: number;
  idempotency_key: string;
  fingerprint: string;
  chunks: ChunkClaim[];
}

export interface OpenedSession {
  state: UploadState;
  error: string | null;
  missing_chunks: string[];
}

export type CompletionPlan =
  | { kind: 'done'; state: UploadStateResponse }
  | {
      kind: 'existing';
      manifest_key: string;
      chunks_key: string;
      nar: StoredNar;
    }
  | { kind: 'inline'; chunks_key: string; nar: StoredNar };

export async function writeChunkList(
  bucket: R2Bucket,
  key: string,
  nar: StoredNar,
): Promise<void> {
  await bucket.put(key, JSON.stringify(chunkList(nar)), {
    httpMetadata: { contentType: 'application/json' },
  });
}

const IN_PROGRESS: UploadState[] = ['QUEUED', 'PROCESSING', 'PUBLISHING'];
const TERMINAL: UploadState[] = ['READY', 'FAILED', 'ABORTED'];

// Holds the GC lease from before the first existence check until publication.
export class UploadSession {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly storage: UploadStorage,
    private readonly publisher: UploadPublisher,
  ) {}

  private serialized<T>(body: () => Promise<T>): Promise<T> {
    const result = this.queue.then(body, body);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private sql() {
    return this.ctx.storage.sql;
  }

  isSession(): boolean {
    return Boolean(
      first(this.sql().exec<SqlRow>('SELECT key FROM session WHERE key = 1')),
    );
  }

  leaseToken(): string | null {
    const row = first(
      this.sql().exec<SqlRow>('SELECT lease_token FROM session WHERE key = 1'),
    );
    return row?.lease_token ? text(row, 'lease_token') : null;
  }

  private missing(): string[] {
    return [
      ...this.sql().exec<{ raw_hash: string }>(
        'SELECT DISTINCT raw_hash FROM session_chunks WHERE present = 0 ORDER BY raw_hash',
      ),
    ].map((row) => text(row, 'raw_hash'));
  }

  private opened(row: UploadRow): OpenedSession {
    return {
      state: row.state,
      error: row.error,
      missing_chunks: row.state === 'UPLOADING' ? this.missing() : [],
    };
  }

  private nar(row: UploadRow): StoredNar {
    return {
      nar_hash: row.manifest.nar_hash,
      nar_size: row.manifest.nar_size,
      chunks: [
        ...this.sql().exec<{ raw_hash: string; raw_size: number }>(
          'SELECT raw_hash, raw_size FROM session_chunks ORDER BY idx',
        ),
      ].map((chunk) => ({
        raw_hash: text(chunk, 'raw_hash'),
        raw_size: integer(chunk, 'raw_size'),
      })),
    };
  }

  private validateOpenInput(
    input: OpenSessionInput,
  ): RpcResult<OpenedSession> | null {
    if (input.chunks.length === 0)
      return failure(
        'invalid_input',
        'upload declares an invalid number of chunks',
        422,
      );
    if (input.chunks.length > CHUNK_LIST_MAX_CHUNKS)
      return failure(
        'invalid_input',
        `upload declares too many chunks (max ${CHUNK_LIST_MAX_CHUNKS})`,
        422,
      );
    try {
      assertValidRawHash(input.manifest.nar_hash);
    } catch {
      return failure(
        'invalid_input',
        'upload declares an invalid NAR hash',
        422,
      );
    }
    if (
      !Number.isSafeInteger(input.manifest.nar_size) ||
      input.manifest.nar_size < 1 ||
      input.manifest.nar_size > MAX_NAR_SIZE
    )
      return failure(
        'invalid_input',
        'upload declares an invalid NAR size',
        422,
      );
    try {
      assertStoreHash(input.manifest.store_hash);
    } catch {
      return failure(
        'invalid_input',
        'upload declares an invalid store hash',
        422,
      );
    }
    for (const chunk of input.chunks) {
      try {
        assertValidRawHash(chunk.raw_hash);
      } catch {
        return failure(
          'invalid_input',
          'upload declares an invalid chunk hash',
          422,
        );
      }
      if (
        !Number.isSafeInteger(chunk.raw_size) ||
        chunk.raw_size < 1 ||
        chunk.raw_size > CHUNK_MAX_RAW_SIZE
      )
        return failure(
          'invalid_input',
          'upload declares an invalid chunk size',
          422,
        );
      try {
        assertValidRawHash(chunk.compressed_hash);
      } catch {
        return failure(
          'invalid_input',
          'upload declares an invalid compressed chunk hash',
          422,
        );
      }
      if (
        !Number.isSafeInteger(chunk.compressed_size) ||
        chunk.compressed_size < 1 ||
        chunk.compressed_size > CHUNK_MAX_COMPRESSED_SIZE
      )
        return failure(
          'invalid_input',
          'upload declares an invalid compressed chunk size',
          422,
        );
    }
    if (
      new Set(input.chunks.map((chunk) => chunk.raw_hash)).size !==
      input.chunks.length
    )
      return failure('invalid_input', 'upload declares duplicate chunks', 422);
    if (
      input.chunks.reduce((sum, chunk) => sum + chunk.raw_size, 0) !==
      input.manifest.nar_size
    )
      return failure(
        'invalid_input',
        'chunk sizes do not add up to the NAR size',
        422,
      );
    return null;
  }

  private existingOpened(
    input: OpenSessionInput,
    existing: UploadRow,
  ): RpcResult<OpenedSession> {
    const sameMetadata =
      existing.idempotency_key === input.idempotency_key &&
      existing.fingerprint === input.fingerprint;
    if (!sameMetadata)
      return failure(
        'idempotency_conflict',
        'upload metadata changed during retry',
        409,
      );
    return ok(this.opened(existing));
  }

  async open(input: OpenSessionInput): Promise<RpcResult<OpenedSession>> {
    const invalid = this.validateOpenInput(input);
    if (invalid) return invalid;
    const early = await this.serialized(async () => {
      const existing = this.storage.row();
      return existing ? this.existingOpened(input, existing) : null;
    });
    if (early) return early;
    const gc = gcControl(this.env);
    const lease = await gc.acquireLease({ job_id: input.job_id });
    if (!lease.ok) return lease;
    const token = lease.value.token;
    if (!token)
      return failure(
        'gc_in_progress',
        'garbage collection is deleting objects; retry shortly',
        503,
      );
    let present: Set<string>;
    let existingManifest: boolean;
    try {
      ({ present, existingManifest } = await this.checkPresent(input));
    } catch (error) {
      await gc
        .releaseLease({ job_id: input.job_id, token })
        .catch(() => undefined);
      throw error;
    }
    let stored = false;
    try {
      const result = await this.serialized(
        async (): Promise<RpcResult<OpenedSession>> => {
          const existing = this.storage.row();
          if (existing) return this.existingOpened(input, existing);
          const inserted = this.storage.insertOpen(
            input,
            { leaseToken: token, existingManifest },
            input.chunks.map((chunk) => ({
              ...chunk,
              present: present.has(chunk.raw_hash),
            })),
          );
          if (!inserted) {
            const current = this.storage.row();
            if (!current) return failure('not_found', 'upload not found', 404);
            return this.existingOpened(input, current);
          }
          stored = true;
          const openedRow = this.storage.row();
          if (!openedRow) return failure('not_found', 'upload not found', 404);
          return ok(this.opened(openedRow));
        },
      );
      if (!stored)
        await gc
          .releaseLease({ job_id: input.job_id, token })
          .catch(() => undefined);
      return result;
    } catch (error) {
      if (!stored)
        await gc
          .releaseLease({ job_id: input.job_id, token })
          .catch(() => undefined);
      throw error;
    }
  }

  private async checkPresent(
    input: OpenSessionInput,
  ): Promise<{ present: Set<string>; existingManifest: boolean }> {
    const reused = await this.env.CACHE_BUCKET.head(
      manifestKey(input.manifest.nar_hash),
    );
    if (!reused)
      return {
        present: await this.presentChunks(input.job_id, input.chunks),
        existingManifest: false,
      };
    const order = [...new Set(input.chunks.map((chunk) => chunk.raw_hash))];
    const canaries = [
      order[0]!,
      order[Math.floor(order.length / 2)]!,
      order[order.length - 1]!,
    ].filter((hash, index, all) => all.indexOf(hash) === index);
    const probes = await Promise.all(
      canaries.map((hash) => this.env.CACHE_BUCKET.head(chunkKey(hash))),
    );
    if (probes.every((probe) => probe !== null))
      return {
        present: new Set(input.chunks.map((chunk) => chunk.raw_hash)),
        existingManifest: true,
      };
    return {
      present: await this.presentChunks(input.job_id, input.chunks),
      existingManifest: true,
    };
  }

  private async presentChunks(
    jobId: string,
    chunks: ChunkClaim[],
  ): Promise<Set<string>> {
    const unique = [...new Set(chunks.map((chunk) => chunk.raw_hash))];
    const present = new Set<string>();
    if (unique.length > MAX_OPEN_HEADS)
      console.warn({
        message:
          'upload open capped HEAD fan-out; remainder reported missing and re-uploaded',
        job_id: jobId,
        unique_chunks: unique.length,
        head_budget: MAX_OPEN_HEADS,
        reported_missing_without_head: unique.length - MAX_OPEN_HEADS,
      });
    const budgeted = unique.slice(0, MAX_OPEN_HEADS);
    for (let start = 0; start < budgeted.length; start += HEAD_CONCURRENCY) {
      await Promise.all(
        budgeted.slice(start, start + HEAD_CONCURRENCY).map(async (hash) => {
          if (await this.env.CACHE_BUCKET.head(chunkKey(hash)))
            present.add(hash);
        }),
      );
    }
    return present;
  }

  async chunkClaim(
    rawHash: string,
  ): Promise<RpcResult<ChunkClaim & { present: boolean }>> {
    const row = this.storage.row();
    if (!row || !this.isSession())
      return failure('not_found', 'upload session not found', 404);
    if (row.state !== 'UPLOADING')
      return failure('not_uploadable', 'upload is not accepting chunks', 409);
    const chunk = first(
      this.sql().exec<SqlRow>(
        'SELECT raw_hash, raw_size, compressed_hash, compressed_size, MIN(present) AS present FROM session_chunks WHERE raw_hash = ? GROUP BY raw_hash, raw_size, compressed_hash, compressed_size',
        rawHash,
      ),
    );
    if (!chunk)
      return failure('unknown_chunk', 'chunk is not part of this upload', 404);
    return ok({
      raw_hash: rawHash,
      raw_size: integer(chunk, 'raw_size'),
      compressed_hash: text(chunk, 'compressed_hash'),
      compressed_size: integer(chunk, 'compressed_size'),
      present: integer(chunk, 'present') === 1,
    });
  }

  async missingChunks(): Promise<RpcResult<string[]>> {
    const row = this.storage.row();
    if (!row || !this.isSession())
      return failure('not_found', 'upload session not found', 404);
    return ok(row.state === 'UPLOADING' ? this.missing() : []);
  }

  async chunkStored(rawHash: string): Promise<RpcResult<void>> {
    return this.serialized(async () => {
      const row = this.storage.row();
      if (!row || !this.isSession())
        return failure('not_found', 'upload session not found', 404);
      if (TERMINAL.includes(row.state))
        return failure(
          'invalid_transition',
          'upload has already finished',
          409,
        );
      if (row.state !== 'UPLOADING')
        return failure('not_uploadable', 'upload is not accepting chunks', 409);
      const known = first(
        this.sql().exec<SqlRow>(
          'SELECT 1 AS known FROM session_chunks WHERE raw_hash = ? LIMIT 1',
          rawHash,
        ),
      );
      if (!known)
        return failure(
          'unknown_chunk',
          'chunk is not part of this upload',
          404,
        );
      const accepted = this.ctx.storage.transactionSync(() => {
        const current = this.storage.row();
        if (
          !current ||
          (current.state !== 'UPLOADING' && current.state !== 'COMPLETING')
        )
          return false;
        this.sql().exec(
          'UPDATE session_chunks SET present = 1 WHERE raw_hash = ?',
          rawHash,
        );
        return true;
      });
      if (!accepted)
        return failure('not_uploadable', 'upload is not accepting chunks', 409);
      return ok();
    });
  }

  beginComplete(): Promise<RpcResult<CompletionPlan>> {
    return this.serialized(async () => {
      const row = this.storage.row();
      if (!row) return failure('not_found', 'upload session not found', 404);
      if (
        ![
          'UPLOADING',
          'COMPLETING',
          'QUEUED',
          'PROCESSING',
          'PUBLISHING',
          'READY',
          'FAILED',
          'ABORTED',
        ].includes(row.state)
      )
        return failure(
          'invalid_transition',
          'upload was never opened; push again with a current cf-nix-cache',
          409,
        );
      if (!this.isSession())
        return failure('not_found', 'upload session not found', 404);
      if (IN_PROGRESS.includes(row.state)) {
        try {
          await ensureWorkflow(
            this.env.PROCESS_UPLOAD!,
            row.job_id,
            toProcessJob(row),
          );
        } catch (error) {
          console.error('upload workflow reconciliation failed', error);
        }
        const current = this.storage.row();
        if (!current) return failure('not_found', 'upload not found', 404);
        return ok({
          kind: 'done',
          state: toStateResponse(current),
        });
      }
      if (TERMINAL.includes(row.state))
        return ok({ kind: 'done', state: toStateResponse(row) });
      if (row.state === 'UPLOADING') {
        const missing = this.missing();
        if (missing.length)
          return failure(
            'chunks_missing',
            `${missing.length} chunks have not been uploaded`,
            409,
          );
        if (!this.storage.setState(row.job_id, ['UPLOADING'], 'COMPLETING'))
          throw new Error('upload left UPLOADING before completion started');
      }
      const nar = this.nar(row);
      const reused = first(
        this.sql().exec<SqlRow>(
          'SELECT existing_manifest FROM session WHERE key = 1',
        ),
      );
      if (reused && integer(reused, 'existing_manifest') === 1)
        return ok({
          kind: 'existing',
          manifest_key: manifestKey(row.manifest.nar_hash),
          chunks_key: row.chunks_key,
          nar,
        });
      if (row.manifest.nar_size <= inlineVerifyLimit(this.env))
        return ok({ kind: 'inline', chunks_key: row.chunks_key, nar });
      await writeChunkList(this.env.CACHE_BUCKET, row.chunks_key, nar);
      if (!this.storage.setQueued(row.job_id)) {
        await this.env.CACHE_BUCKET.delete(row.chunks_key).catch(
          (error: unknown) => console.error('chunk list cleanup failed', error),
        );
        const current = this.storage.row();
        if (!current) return failure('not_found', 'upload not found', 404);
        return ok({
          kind: 'done',
          state: toStateResponse(current),
        });
      }
      const queued = this.storage.row();
      if (!queued) return failure('not_found', 'upload not found', 404);
      try {
        await ensureWorkflow(
          this.env.PROCESS_UPLOAD!,
          row.job_id,
          toProcessJob(queued),
        );
      } catch (error) {
        console.error('upload workflow reconciliation failed', error);
      }
      const done = this.storage.row();
      if (!done) return failure('not_found', 'upload not found', 404);
      return ok({ kind: 'done', state: toStateResponse(done) });
    });
  }

  publishVerified(
    result: ProcessResult,
    manifest?: ChunkManifest,
  ): Promise<RpcResult<UploadStateResponse>> {
    return this.serialized(async () => {
      const row = this.storage.row();
      if (!row) return failure('not_found', 'upload not found', 404);
      if (row.state !== 'COMPLETING') return ok(toStateResponse(row));
      const token = this.leaseToken();
      const gc = gcControl(this.env);
      const lease = token
        ? await gc.prepublish({
            job_id: row.job_id,
            token,
            manifest_key: result.manifest_key,
          })
        : null;
      if (lease && !lease.ok) return lease;
      if (!lease?.value.valid) {
        this.storage.setError(
          row.job_id,
          'the upload held its garbage collection lease too long; push again',
        );
        const current = this.storage.row();
        if (!current) return failure('not_found', 'upload not found', 404);
        return ok(toStateResponse(current));
      }
      if (!this.storage.setState(row.job_id, ['COMPLETING'], 'PROCESSING')) {
        const current = this.storage.row();
        if (!current) return failure('not_found', 'upload not found', 404);
        return ok(toStateResponse(current));
      }
      const published = await this.publisher.publish(result, manifest);
      if (!published.ok) {
        if (published.error.status >= 500) {
          await ensureWorkflow(
            this.env.PROCESS_UPLOAD!,
            row.job_id,
            toProcessJob(this.storage.row() ?? row),
          ).catch((error: unknown) =>
            console.error('upload workflow reconciliation failed', error),
          );
          return published;
        }
        this.storage.setError(
          row.job_id,
          `${published.error.code}: ${published.error.message}`,
        );
      }
      await this.releaseLease();
      const finished = this.storage.row();
      if (!finished) return failure('not_found', 'upload not found', 404);
      return ok(toStateResponse(finished));
    });
  }

  reject(message: string): Promise<RpcResult<UploadStateResponse>> {
    return this.serialized(async () => {
      const row = this.storage.row();
      if (!row) return failure('not_found', 'upload not found', 404);
      if (row.state === 'UPLOADING' || row.state === 'COMPLETING') {
        this.storage.setError(row.job_id, message);
        await this.releaseLease();
      }
      const current = this.storage.row();
      if (!current) return failure('not_found', 'upload not found', 404);
      return ok(toStateResponse(current));
    });
  }

  async releaseLease(): Promise<void> {
    const row = this.storage.row();
    const token = this.leaseToken();
    if (!row || !token) return;
    try {
      await gcControl(this.env).releaseLease({ job_id: row.job_id, token });
    } catch (error) {
      console.error('gc lease release failed', error);
    }
  }
}
