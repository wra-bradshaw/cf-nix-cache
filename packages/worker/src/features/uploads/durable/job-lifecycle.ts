import { failure, ok, type RpcResult } from '../../../shared/rpc';
import { ensureWorkflow } from '../../../shared/workflows';
import type { UploadStateResponse } from '../types';
import { UploadStorage } from './storage';
import { toProcessJob, toStateResponse } from './upload-row';

export class UploadJobLifecycle {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly storage: UploadStorage,
  ) {}

  async processing(): Promise<RpcResult<void>> {
    return this.ctx.storage.transactionSync(() => {
      const row = this.storage.row();
      if (!row) return failure('not_found', 'upload not found', 404);
      if (['READY', 'PROCESSING', 'PUBLISHING'].includes(row.state))
        return ok();
      if (row.state !== 'QUEUED')
        return failure(
          'invalid_transition',
          'upload is not queued for processing',
          409,
        );
      this.ctx.storage.sql.exec(
        "UPDATE job SET state = 'PROCESSING' WHERE job_id = ?",
        row.job_id,
      );
      return ok();
    });
  }

  async fail(message: string): Promise<RpcResult<void>> {
    this.ctx.storage.transactionSync(() => {
      const row = this.storage.row();
      if (!row || ['READY', 'ABORTED'].includes(row.state)) return;
      this.ctx.storage.sql.exec(
        "UPDATE job SET state = 'FAILED', error = ? WHERE job_id = ?",
        message.slice(0, 2000),
        row.job_id,
      );
    });
    return ok();
  }

  async abort(): Promise<RpcResult<UploadStateResponse>> {
    const row = this.storage.row();
    if (!row) return failure('not_found', 'upload not found', 404);
    // Once processing has started, publication may be in flight outside this
    // Durable Object. Allowing an abort here would race that publication and
    // could leave an ABORTED job with a live path in the cache.
    if (row.state === 'PROCESSING' || row.state === 'PUBLISHING')
      return failure(
        'invalid_transition',
        'upload cannot be aborted after processing has started',
        409,
      );
    // Fence the job before awaiting R2. Otherwise completion/processing can
    // advance the job while the multipart abort is in flight, after which the
    // stale abort would overwrite PROCESSING or PUBLISHING with ABORTED.
    this.ctx.storage.transactionSync(() => {
      const current = this.storage.row();
      if (
        current &&
        ['UPLOADING', 'COMPLETING', 'QUEUED'].includes(current.state)
      )
        this.ctx.storage.sql.exec(
          "UPDATE job SET state = 'ABORTED' WHERE job_id = ?",
          current.job_id,
        );
    });
    if (row.upload_id && ['UPLOADING', 'COMPLETING'].includes(row.state))
      await this.env.CACHE_BUCKET.resumeMultipartUpload(
        row.staging_key,
        row.upload_id,
      )
        .abort()
        .catch(() => undefined);
    return ok(toStateResponse(this.storage.row()!));
  }

  async state(): Promise<RpcResult<UploadStateResponse>> {
    const row = this.storage.row();
    if (!row) return failure('not_found', 'upload not found', 404);
    if (['QUEUED', 'PROCESSING', 'PUBLISHING'].includes(row.state)) {
      // Reconciliation is opportunistic: a Workflows outage must not make the
      // stored state unreadable. The client's next poll tries again.
      try {
        await ensureWorkflow(
          this.env.PROCESS_UPLOAD!,
          row.job_id,
          toProcessJob(row),
        );
      } catch (error) {
        console.error('upload workflow reconciliation failed', error);
      }
    }
    return ok(toStateResponse(this.storage.row()!));
  }
}
