import { type RpcResult, failure, ok } from '../../../shared/rpc';
import { first, type SqlRow } from '../../../shared/sql';
import { ensureWorkflow } from '../../../shared/workflows';
import { gcControl } from '../../gc/gc-adapters';
import { chunkKey, manifestKey, type ChunkClaim } from '../encoding';
import type {
  ChunkManifest,
  ProcessResult,
  UploadManifest,
  UploadState,
  UploadStateResponse,
} from '../types';
import {
  INLINE_VERIFY_MAX_NAR_SIZE,
  chunkList,
  type StoredNar,
} from '../verify-stored';
import type { UploadPublisher } from './publish';
import type { UploadStorage } from './storage';
import { toProcessJob, toStateResponse, type UploadRow } from './upload-row';

/** Parallel R2 HEADs when a session opens. */
const HEAD_CONCURRENCY = 16;

export interface OpenSessionInput {
  job_id: string;
  cache: string;
  cache_id: string;
  incarnation: string;
  staging_key: string;
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

/**
 * The caller verifies `inline` and `existing` plans, and writes the chunk list
 * to `chunks_key` before publishing them. The list lets the processor
 * workflow finish a publication interrupted in PROCESSING.
 */
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

/**
 * A client-encoded upload: the client sends only the chunks the bucket lacks,
 * and completion checks the stored chunks instead of re-encoding a NAR.
 *
 * The upload holds a garbage collection lease from before it first looks for
 * existing chunks until publication. A chunk reported present could otherwise
 * be swept before the manifest that references it is published.
 */
export class UploadSession {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly storage: UploadStorage,
    private readonly publisher: UploadPublisher,
  ) {}

  /** Runs `body` after every earlier call has finished. */
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
    return row?.lease_token ? String(row.lease_token) : null;
  }

  private missing(): string[] {
    return [
      ...this.sql().exec<{ raw_hash: string }>(
        'SELECT DISTINCT raw_hash FROM session_chunks WHERE present = 0 ORDER BY raw_hash',
      ),
    ].map((row) => String(row.raw_hash));
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
        raw_hash: String(chunk.raw_hash),
        raw_size: Number(chunk.raw_size),
      })),
    };
  }

  open(input: OpenSessionInput): Promise<RpcResult<OpenedSession>> {
    return this.serialized(async () => {
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
        return ok(this.opened(existing));
      }
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
      try {
        const reused = await this.env.CACHE_BUCKET.head(
          manifestKey(input.manifest.nar_hash),
        );
        const present = reused
          ? new Set(input.chunks.map((chunk) => chunk.raw_hash))
          : await this.presentChunks(input.chunks);
        this.ctx.storage.transactionSync(() => {
          this.storage.insert({ ...input, upload_id: null });
          this.sql().exec(
            'INSERT INTO session (key, lease_token, chunks_key, existing_manifest) VALUES (1, ?, ?, ?)',
            token,
            `staging/${input.job_id}.chunks.json`,
            reused ? 1 : 0,
          );
          input.chunks.forEach((chunk, index) =>
            this.sql().exec(
              'INSERT INTO session_chunks (idx, raw_hash, raw_size, compressed_hash, compressed_size, present) VALUES (?, ?, ?, ?, ?, ?)',
              index,
              chunk.raw_hash,
              chunk.raw_size,
              chunk.compressed_hash,
              chunk.compressed_size,
              present.has(chunk.raw_hash) ? 1 : 0,
            ),
          );
        });
      } catch (error) {
        await gc
          .releaseLease({ job_id: input.job_id, token })
          .catch(() => undefined);
        throw error;
      }
      return ok(this.opened(this.storage.row()!));
    });
  }

  private async presentChunks(chunks: ChunkClaim[]): Promise<Set<string>> {
    const unique = [...new Set(chunks.map((chunk) => chunk.raw_hash))];
    const present = new Set<string>();
    for (let start = 0; start < unique.length; start += HEAD_CONCURRENCY) {
      await Promise.all(
        unique.slice(start, start + HEAD_CONCURRENCY).map(async (hash) => {
          if (await this.env.CACHE_BUCKET.head(chunkKey(hash)))
            present.add(hash);
        }),
      );
    }
    return present;
  }

  /** What an uploaded chunk must be, if the session still needs it. */
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
        'SELECT raw_size, compressed_hash, compressed_size, MIN(present) AS present FROM session_chunks WHERE raw_hash = ? GROUP BY raw_hash',
        rawHash,
      ),
    );
    if (!chunk)
      return failure('unknown_chunk', 'chunk is not part of this upload', 404);
    return ok({
      raw_hash: rawHash,
      raw_size: Number(chunk.raw_size),
      compressed_hash: String(chunk.compressed_hash),
      compressed_size: Number(chunk.compressed_size),
      present: Number(chunk.present) === 1,
    });
  }

  /** Chunks still to send; empty once the upload stops accepting them. */
  async missingChunks(): Promise<RpcResult<string[]>> {
    const row = this.storage.row();
    if (!row || !this.isSession())
      return failure('not_found', 'upload session not found', 404);
    return ok(row.state === 'UPLOADING' ? this.missing() : []);
  }

  async chunkStored(rawHash: string): Promise<RpcResult<void>> {
    this.ctx.storage.transactionSync(() =>
      this.sql().exec(
        'UPDATE session_chunks SET present = 1 WHERE raw_hash = ?',
        rawHash,
      ),
    );
    return ok();
  }

  /**
   * Moves the upload to COMPLETING and says how to verify it: in the calling
   * Worker for small NARs, or by the processor workflow for large ones.
   */
  beginComplete(): Promise<RpcResult<CompletionPlan>> {
    return this.serialized(async () => {
      const row = this.storage.row();
      if (!row || !this.isSession())
        return failure('not_found', 'upload session not found', 404);
      if (IN_PROGRESS.includes(row.state)) {
        await ensureWorkflow(
          this.env.PROCESS_UPLOAD!,
          row.job_id,
          toProcessJob(row),
        );
        return ok({
          kind: 'done',
          state: toStateResponse(this.storage.row()!),
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
        this.storage.setState(row.job_id, ['UPLOADING'], 'COMPLETING');
      }
      const nar = this.nar(row);
      const reused = first(
        this.sql().exec<SqlRow>(
          'SELECT existing_manifest FROM session WHERE key = 1',
        ),
      );
      if (Number(reused?.existing_manifest) === 1)
        return ok({
          kind: 'existing',
          manifest_key: manifestKey(row.manifest.nar_hash),
          chunks_key: row.chunks_key!,
          nar,
        });
      if (row.manifest.nar_size <= INLINE_VERIFY_MAX_NAR_SIZE)
        return ok({ kind: 'inline', chunks_key: row.chunks_key!, nar });
      await writeChunkList(this.env.CACHE_BUCKET, row.chunks_key!, nar);
      // The workflow acquires the lease under the same job ID, replacing this
      // upload's token without a gap in which chunks could be swept.
      this.storage.setQueued(row.job_id);
      await ensureWorkflow(
        this.env.PROCESS_UPLOAD!,
        row.job_id,
        toProcessJob(this.storage.row()!),
      );
      return ok({ kind: 'done', state: toStateResponse(this.storage.row()!) });
    });
  }

  /** Publishes a manifest the caller verified (or found) under the lease. */
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
        return ok(toStateResponse(this.storage.row()!));
      }
      this.storage.setState(row.job_id, ['COMPLETING'], 'PROCESSING');
      const published = await this.publisher.publish(result, manifest);
      if (!published.ok) {
        // A retryable failure leaves PROCESSING, which the processor workflow
        // finishes on the next status poll.
        if (published.error.status >= 500) return published;
        this.storage.setError(
          row.job_id,
          `${published.error.code}: ${published.error.message}`,
        );
      }
      await this.releaseLease();
      return ok(toStateResponse(this.storage.row()!));
    });
  }

  /** Marks the upload FAILED because its content was rejected. */
  reject(message: string): Promise<RpcResult<UploadStateResponse>> {
    return this.serialized(async () => {
      const row = this.storage.row();
      if (!row) return failure('not_found', 'upload not found', 404);
      if (row.state === 'UPLOADING' || row.state === 'COMPLETING') {
        this.storage.setError(row.job_id, message);
        await this.releaseLease();
      }
      return ok(toStateResponse(this.storage.row()!));
    });
  }

  /** Best-effort: an unreleased lease only delays a sweep until it expires. */
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
