import type {
  ChunkManifest,
  CompleteUploadRequest,
  ProcessResult,
  UploadManifest,
  UploadState,
  UploadStateResponse,
} from '../types';
import { type RpcResult, failure, ok } from '../../../shared/rpc';
import { getCache } from '../../cache/resolve-cache';
import { coordinator } from '../../cache/stubs';
import type { ChunkClaim } from '../encoding';
import { UploadMultipart } from './multipart';
import { UploadJobLifecycle } from './job-lifecycle';
import { UploadPublisher } from './publish';
import {
  type CompletionPlan,
  type OpenSessionInput,
  type OpenedSession,
  UploadSession,
} from './session';
import { UploadStorage } from './storage';
import { RpcOnlyDurableObject } from '../../../shared/rpc-only-durable-object';

const TERMINAL: UploadState[] = ['READY', 'FAILED', 'ABORTED'];

export class UploadJob extends RpcOnlyDurableObject {
  private readonly storage: UploadStorage;
  private readonly multipart: UploadMultipart;
  private readonly publisher: UploadPublisher;
  private readonly lifecycle: UploadJobLifecycle;
  private readonly session: UploadSession;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.storage = new UploadStorage(ctx);
    this.multipart = new UploadMultipart(ctx, env, this.storage);
    this.publisher = new UploadPublisher(env, this.storage);
    this.lifecycle = new UploadJobLifecycle(ctx, env, this.storage);
    this.session = new UploadSession(ctx, env, this.storage, this.publisher);
  }

  async access(): Promise<
    RpcResult<{ cache: string; state: UploadState; encoded: boolean }>
  > {
    const row = this.storage.row();
    return row
      ? ok({
          cache: row.cache,
          state: row.state,
          encoded: Boolean(row.chunks_key),
        })
      : failure('not_found', 'upload not found', 404);
  }

  init(input: {
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
    return this.multipart.init(input);
  }

  putPart(input: {
    number: number;
    length: number;
    body: ReadableStream<Uint8Array> | null;
  }): Promise<RpcResult<{ part_number: number; etag: string }>> {
    return this.multipart.putPart(input);
  }

  complete(
    input: CompleteUploadRequest,
  ): Promise<RpcResult<UploadStateResponse>> {
    return this.settled(this.multipart.complete(input));
  }

  openSession(input: OpenSessionInput): Promise<RpcResult<OpenedSession>> {
    return this.session.open(input);
  }

  chunkClaim(
    rawHash: string,
  ): Promise<RpcResult<ChunkClaim & { present: boolean }>> {
    return this.session.chunkClaim(rawHash);
  }

  missingChunks(): Promise<RpcResult<string[]>> {
    return this.session.missingChunks();
  }

  chunkStored(rawHash: string): Promise<RpcResult<void>> {
    return this.session.chunkStored(rawHash);
  }

  beginComplete(): Promise<RpcResult<CompletionPlan>> {
    return this.session.beginComplete();
  }

  publishVerified(
    result: ProcessResult,
    manifest?: ChunkManifest,
  ): Promise<RpcResult<UploadStateResponse>> {
    return this.settled(this.session.publishVerified(result, manifest));
  }

  reject(message: string): Promise<RpcResult<UploadStateResponse>> {
    return this.settled(this.session.reject(message));
  }

  processing(): Promise<RpcResult<void>> {
    return this.lifecycle.processing();
  }

  publish(result: ProcessResult): Promise<RpcResult<void>> {
    return this.settled(this.publisher.publish(result));
  }

  async fail(message: string): Promise<RpcResult<void>> {
    const result = await this.settled(this.lifecycle.fail(message));
    await this.session.releaseLease();
    return result;
  }

  async abort(): Promise<RpcResult<UploadStateResponse>> {
    const row = this.storage.row();
    // A session in COMPLETING is being verified and published by a request
    // outside this object, as PROCESSING is by the workflow.
    if (row?.chunks_key && row.state === 'COMPLETING')
      return failure(
        'invalid_transition',
        'upload cannot be aborted while it is being verified',
        409,
      );
    const result = await this.settled(this.lifecycle.abort());
    if (this.storage.row()?.state === 'ABORTED')
      await this.session.releaseLease();
    return result;
  }

  state(): Promise<RpcResult<UploadStateResponse>> {
    return this.lifecycle.state();
  }

  /**
   * Once the upload has finished, either way, tells the cache coordinator that
   * the path is no longer in flight. Best-effort: in-flight entries also
   * expire, and allocation skips ones whose upload has finished.
   */
  private async settled<T>(result: Promise<T>): Promise<T> {
    const value = await result;
    const row = this.storage.row();
    if (row && TERMINAL.includes(row.state)) {
      try {
        const cache = await getCache(this.env, row.cache);
        if (cache.reference.id === row.cache_id)
          await coordinator(this.env, cache.reference).releaseUpload({
            store_hash: row.manifest.store_hash,
            upload_id: row.job_id,
          });
      } catch (error) {
        console.error('releasing in-flight upload failed', error);
      }
    }
    return value;
  }
}
