import { failure, ok, type RpcResult } from '../../../shared/rpc';
import { ensureWorkflow } from '../../../shared/workflows';
import type { UploadStateResponse } from '../types';
import { UploadStorage } from './storage';
import { toProcessJob, toStateResponse } from './upload-row';

const KNOWN_STATES: string[] = [
  'UPLOADING',
  'COMPLETING',
  'QUEUED',
  'PROCESSING',
  'PUBLISHING',
  'READY',
  'FAILED',
  'ABORTED',
];

export class UploadJobLifecycle {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly storage: UploadStorage,
  ) {}

  /**
   * Claims a QUEUED upload for the workflow. The read and the conditional
   * write race with `fail`: `setState` applies only when the row is still
   * QUEUED and reports whether it did, so a lost race is re-read and
   * reported instead of returning success for a FAILED upload.
   */
  async processing(): Promise<RpcResult<void>> {
    const row = this.storage.row();
    if (!row) return failure('not_found', 'upload not found', 404);
    if (['READY', 'PROCESSING', 'PUBLISHING'].includes(row.state)) return ok();
    if (row.state !== 'QUEUED')
      return failure(
        'invalid_transition',
        'upload is not queued for processing',
        409,
      );
    if (this.storage.setState(row.job_id, ['QUEUED'], 'PROCESSING'))
      return ok();
    const current = this.storage.row();
    if (!current) return failure('not_found', 'upload not found', 404);
    // Another claimant already moved it forward; retries are idempotent.
    if (['READY', 'PROCESSING', 'PUBLISHING'].includes(current.state))
      return ok();
    return failure(
      'invalid_transition',
      'upload is not queued for processing',
      409,
    );
  }

  async fail(message: string): Promise<RpcResult<void>> {
    const row = this.storage.row();
    if (!row || ['READY', 'ABORTED'].includes(row.state)) return ok();
    // Conditional: a concurrent publish may have reached READY since the
    // read. A false return means the terminal state won; this still reports
    // ok either way, so the return is dropped instead of re-reading a row
    // nobody uses.
    this.storage.setError(row.job_id, message);
    return ok();
  }

  /**
   * Aborts an upload that has not started processing. Like `processing`, the
   * conditional `setState` reports a lost race with `processing`/`fail`, which
   * is re-read so an upload that already moved to PROCESSING reports a
   * conflict instead of a silent no-op.
   */
  async abort(): Promise<RpcResult<UploadStateResponse>> {
    const row = this.storage.row();
    if (!row) return failure('not_found', 'upload not found', 404);
    // Once processing has started, publication may be in flight outside this
    // Durable Object. Allowing an abort here would race that publication and
    // could leave an ABORTED job with a live path in the cache.
    if (
      row.state === 'PROCESSING' ||
      row.state === 'PUBLISHING' ||
      row.state === 'COMPLETING'
    )
      return failure(
        'invalid_transition',
        'upload cannot be aborted after processing has started',
        409,
      );
    if (['UPLOADING', 'QUEUED'].includes(row.state)) {
      if (this.storage.setState(row.job_id, ['UPLOADING', 'QUEUED'], 'ABORTED')) {
        const wrote = this.storage.row();
        if (!wrote) return failure('not_found', 'upload not found', 404);
        return ok(toStateResponse(wrote));
      }
      const current = this.storage.row();
      if (!current) return failure('not_found', 'upload not found', 404);
      if (
        current.state === 'PROCESSING' ||
        current.state === 'PUBLISHING' ||
        current.state === 'COMPLETING'
      )
        return failure(
          'invalid_transition',
          'upload cannot be aborted after processing has started',
          409,
        );
    }
    const tail = this.storage.row();
    if (!tail) return failure('not_found', 'upload not found', 404);
    if (['READY', 'FAILED', 'ABORTED'].includes(tail.state))
      return ok(toStateResponse(tail));
    return failure(
      'invalid_transition',
      'upload cannot be aborted in its current state',
      409,
    );
  }

  async state(): Promise<RpcResult<UploadStateResponse>> {
    const row = this.storage.row();
    if (!row) return failure('not_found', 'upload not found', 404);
    if (!row.encoded)
      return failure(
        'invalid_transition',
        'upload is no longer supported; push again with a current cf-nix-cache',
        409,
      );
    if (!KNOWN_STATES.includes(row.state))
      return failure(
        'invalid_transition',
        'upload is in an unknown state',
        409,
      );
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
    const tail = this.storage.row();
    if (!tail) return failure('not_found', 'upload not found', 404);
    if (!KNOWN_STATES.includes(tail.state))
      return failure(
        'invalid_transition',
        'upload is in an unknown state',
        409,
      );
    return ok(toStateResponse(tail));
  }
}
