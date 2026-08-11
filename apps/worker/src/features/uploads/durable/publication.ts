import { renderNarInfo } from '../../nix/narinfo';
import {
  ChunkManifestSchema,
  parseJsonSchema,
  transition,
} from '../../domain/validation';
import type {
  PathRecord,
  ProcessResult,
  UploadStateResponse,
} from '../../../types';
import { publicationFor } from '../../cache';
import { PublicationError } from '../../cache/application';
import { ensureWorkflow } from '../../workflows/workflow';
import type { RpcResult } from '../../../rpc';
import { getCache } from '../../runtime/http';
import { now } from '../../../infrastructure/durable/shared';
import { failure, processJob, state } from './model';
import { UploadStorage } from './storage';

export class UploadPublication {
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
        return { ok: true, value: undefined };
      if (row.state !== 'QUEUED')
        return failure(
          'invalid_transition',
          'upload is not queued for processing',
          409,
        );
      transition(row.state, 'PROCESSING');
      this.ctx.storage.sql.exec(
        "UPDATE job SET state = 'PROCESSING' WHERE job_id = ?",
        row.job_id,
      );
      return { ok: true, value: undefined };
    });
  }

  async publish(result: ProcessResult): Promise<RpcResult<void>> {
    const row = this.storage.row();
    if (!row) return failure('not_found', 'upload not found', 404);
    if (row.state === 'READY') return { ok: true, value: undefined };
    if (!['PROCESSING', 'PUBLISHING'].includes(row.state))
      return failure(
        'invalid_transition',
        'upload is not ready for publication',
        409,
      );
    const cache = await getCache(this.env, row.cache);
    if (
      cache.reference.id !== row.cache_id ||
      cache.reference.incarnation !== row.incarnation
    )
      return failure(
        'cache_recreated',
        'upload belongs to an older cache incarnation',
        409,
      );
    const manifestObject = await this.env.CACHE_BUCKET.get(result.manifest_key);
    if (!manifestObject)
      return failure(
        'publication_result_missing',
        'processor manifest is missing',
        503,
      );
    let manifest: ProcessResult['manifest'];
    try {
      manifest = parseJsonSchema(
        ChunkManifestSchema,
        await manifestObject.json<unknown>(),
      );
    } catch {
      return failure('invalid_input', 'processor manifest is invalid', 422);
    }
    if (
      manifest.nar_hash !== row.manifest.nar_hash ||
      manifest.nar_size !== row.manifest.nar_size
    )
      return failure(
        'invalid_input',
        'processor manifest does not match upload metadata',
        422,
      );
    this.storage.setResult(
      row.job_id,
      {
        manifest_key: result.manifest_key,
        deduplicated: result.deduplicated,
      },
      ['PROCESSING', 'PUBLISHING'],
      'PUBLISHING',
    );
    const record: PathRecord = {
      cache: row.cache,
      store_hash: row.manifest.store_hash,
      store_path: row.manifest.store_path,
      nar_hash: row.manifest.nar_hash,
      nar_size: row.manifest.nar_size,
      references: row.manifest.references,
      deriver: row.manifest.deriver,
      ca: row.manifest.ca,
      manifest_key: result.manifest_key,
      narinfo: '',
      file_hash: manifest.file_hash,
      file_size: manifest.file_size,
      last_accessed: now(),
      created_at: now(),
    };
    record.narinfo = await renderNarInfo(this.env, record, manifest);
    try {
      await publicationFor(this.env, cache, row.manifest.store_hash).execute(
        `publish:${row.job_id}`,
        { kind: 'upsert', record },
      );
    } catch (error) {
      // Preserve the retryability classification across the Durable Object
      // RPC boundary. The workflow must be able to make quota/lifecycle
      // rejection terminal instead of leaving the job in PUBLISHING forever.
      if (error instanceof PublicationError)
        return failure(
          'publication_failed',
          error.message,
          error.retryable ? 503 : 409,
        );
      throw error;
    }
    this.storage.setState(row.job_id, ['PUBLISHING'], 'READY');
    await this.env.CACHE_BUCKET.delete(row.staging_key);
    return { ok: true, value: undefined };
  }

  async fail(message: string, terminal = true): Promise<RpcResult<void>> {
    if (!terminal) return { ok: true, value: undefined };
    this.ctx.storage.transactionSync(() => {
      const row = this.storage.row();
      if (!row || ['READY', 'ABORTED'].includes(row.state)) return;
      this.ctx.storage.sql.exec(
        "UPDATE job SET state = 'FAILED', error = ? WHERE job_id = ?",
        message.slice(0, 2000),
        row.job_id,
      );
    });
    return { ok: true, value: undefined };
  }

  async abort(): Promise<RpcResult<UploadStateResponse>> {
    const row = this.storage.row();
    if (!row) return failure('not_found', 'upload not found', 404);
    // Once processing has started, publication may be in flight outside this
    // Durable Object. Allowing an abort here would race that publication and
    // could leave an ABORTED job with a live path in the cache. The domain
    // transition graph intentionally permits abort only before PROCESSING.
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
    return { ok: true, value: state(this.storage.row()!) };
  }

  async state(): Promise<RpcResult<UploadStateResponse>> {
    const row = this.storage.row();
    if (!row) return failure('not_found', 'upload not found', 404);
    if (['QUEUED', 'PROCESSING', 'PUBLISHING'].includes(row.state))
      await ensureWorkflow(
        this.env.PROCESS_UPLOAD!,
        row.job_id,
        processJob(row),
      );
    return { ok: true, value: state(this.storage.row()!) };
  }
}
