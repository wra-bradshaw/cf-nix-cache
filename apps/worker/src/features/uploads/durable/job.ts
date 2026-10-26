import type {
  CompleteUploadRequest,
  ProcessResult,
  UploadManifest,
  UploadState,
  UploadStateResponse,
} from '../../../types';
import type { RpcResult } from '../../../rpc';
import { UploadMultipart } from './multipart';
import { UploadPublication } from './publication';
import { UploadStorage } from './storage';
import { failure, ok } from '../../../infrastructure/durable/shared';
import { RpcOnlyDurableObject } from '../../../infrastructure/durable/rpc-only';

export class UploadJob extends RpcOnlyDurableObject {
  private readonly storage: UploadStorage;
  private readonly multipart: UploadMultipart;
  private readonly publication: UploadPublication;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.storage = new UploadStorage(ctx);
    this.multipart = new UploadMultipart(ctx, env, this.storage);
    this.publication = new UploadPublication(ctx, env, this.storage);
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
    return this.publication.processing();
  }

  publish(result: ProcessResult): Promise<RpcResult<void>> {
    return this.publication.publish(result);
  }

  fail(message: string): Promise<RpcResult<void>> {
    return this.publication.fail(message);
  }

  abort(): Promise<RpcResult<UploadStateResponse>> {
    return this.publication.abort();
  }

  state(): Promise<RpcResult<UploadStateResponse>> {
    return this.publication.state();
  }
}
