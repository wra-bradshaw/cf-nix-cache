import type {
  CompleteUploadRequest,
  ProcessResult,
  UploadManifest,
  UploadState,
  UploadStateResponse,
} from '../types';
import { type RpcResult, failure, ok } from '../../../shared/rpc';
import { UploadMultipart } from './multipart';
import { UploadJobLifecycle } from './job-lifecycle';
import { UploadPublisher } from './publish';
import { UploadStorage } from './storage';
import { RpcOnlyDurableObject } from '../../../shared/rpc-only-durable-object';

export class UploadJob extends RpcOnlyDurableObject {
  private readonly storage: UploadStorage;
  private readonly multipart: UploadMultipart;
  private readonly publisher: UploadPublisher;
  private readonly lifecycle: UploadJobLifecycle;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.storage = new UploadStorage(ctx);
    this.multipart = new UploadMultipart(ctx, env, this.storage);
    this.publisher = new UploadPublisher(env, this.storage);
    this.lifecycle = new UploadJobLifecycle(ctx, env, this.storage);
  }

  async access(): Promise<RpcResult<{ cache: string; state: UploadState }>> {
    const row = this.storage.row();
    return row
      ? ok({ cache: row.cache, state: row.state })
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
    return this.multipart.complete(input);
  }

  processing(): Promise<RpcResult<void>> {
    return this.lifecycle.processing();
  }

  publish(result: ProcessResult): Promise<RpcResult<void>> {
    return this.publisher.publish(result);
  }

  fail(message: string): Promise<RpcResult<void>> {
    return this.lifecycle.fail(message);
  }

  abort(): Promise<RpcResult<UploadStateResponse>> {
    return this.lifecycle.abort();
  }

  state(): Promise<RpcResult<UploadStateResponse>> {
    return this.lifecycle.state();
  }
}
