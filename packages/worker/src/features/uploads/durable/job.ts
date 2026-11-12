import type {
  ChunkManifest,
  ProcessResult,
  UploadState,
  UploadStateResponse,
} from '../types';
import { type RpcResult, failure, ok } from '../../../shared/rpc';
import { getCache } from '../../cache/resolve-cache';
import { coordinator } from '../../cache/stubs';
import type { ChunkClaim } from '../encoding';
import { UploadJobLifecycle } from './job-lifecycle';
import { UploadPublisher } from './publish';
import {
  type CompletionPlan,
  type JoinResult,
  type OpenSessionInput,
  type OpenedSession,
  UploadSession,
} from './session';
import { UploadStorage } from './storage';
import { RpcOnlyDurableObject } from '../../../shared/rpc-only-durable-object';

const TERMINAL: UploadState[] = ['READY', 'FAILED', 'ABORTED'];

export class UploadJob extends RpcOnlyDurableObject {
  private readonly storage: UploadStorage;
  private readonly publisher: UploadPublisher;
  private readonly lifecycle: UploadJobLifecycle;
  private readonly session: UploadSession;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.storage = new UploadStorage(ctx);
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
          encoded: row.encoded,
        })
      : failure('not_found', 'upload not found', 404);
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

  join(chunks: ChunkClaim[]): Promise<RpcResult<JoinResult>> {
    return this.session.join(chunks);
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
    if (row?.encoded && row.state === 'COMPLETING')
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

  async state(): Promise<RpcResult<UploadStateResponse>> {
    await this.session.scheduleStallRecovery();
    return this.lifecycle.state();
  }

  // Deletes a finished upload's storage. Garbage collection calls this for
  // allocations past the retry window; an upload still under way stays.
  async purge(): Promise<RpcResult<{ purged: boolean }>> {
    let row: ReturnType<UploadStorage['row']>;
    try {
      row = this.storage.row();
    } catch {
      // Unreadable, so it cannot be resumed either.
      row = null;
    }
    if (row && !TERMINAL.includes(row.state)) return ok({ purged: false });
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return ok({ purged: true });
  }

  async alarm(): Promise<void> {
    await this.session.recoverStalledCompletion();
  }

  private async settled<T>(result: Promise<T>): Promise<T> {
    const value = await result;
    const row = this.storage.row();
    if (row && TERMINAL.includes(row.state)) {
      await this.ctx.storage.deleteAlarm();
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
