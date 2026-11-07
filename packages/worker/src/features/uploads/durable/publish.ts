import { now } from '../../../shared/clock';
import { DomainError } from '../../../shared/errors';
import { ApiCallError, failure, ok, type RpcResult } from '../../../shared/rpc';
import { ChunkManifestSchema, parseJsonSchema } from '../../../shared/schemas';
import { publicationFor } from '../../cache/publication-adapters';
import { PublicationError } from '../../cache/publication-protocol';
import { getCache } from '../../cache/resolve-cache';
import type { CacheState, PathRecord } from '../../cache/types';
import { renderNarInfo } from '../../nix/narinfo';
import type { ChunkManifest, ProcessResult } from '../types';
import { UploadStorage } from './storage';

export class UploadPublisher {
  constructor(
    private readonly env: Env,
    private readonly storage: UploadStorage,
  ) {}

  /**
   * `verified` is a manifest the caller has just built or checked; otherwise
   * the manifest is read back from the bucket.
   */
  async publish(
    result: ProcessResult,
    verified?: ChunkManifest,
  ): Promise<RpcResult<void>> {
    const row = this.storage.row();
    if (!row) return failure('not_found', 'upload not found', 404);
    if (row.state === 'READY') return ok();
    if (!['PROCESSING', 'PUBLISHING'].includes(row.state))
      return failure(
        'invalid_transition',
        'upload is not ready for publication',
        409,
      );
    let cache: CacheState;
    try {
      cache = await getCache(this.env, row.cache);
    } catch (error) {
      // A removed or invalid cache is a classified failure, so the workflow
      // can make it terminal instead of retrying publication forever.
      if (error instanceof ApiCallError || error instanceof DomainError)
        return failure(error.code, error.message, error.status);
      throw error;
    }
    if (
      cache.reference.id !== row.cache_id ||
      cache.reference.incarnation !== row.incarnation
    )
      return failure(
        'cache_recreated',
        'upload belongs to an older cache incarnation',
        409,
      );
    let manifest: ChunkManifest;
    if (verified) manifest = verified;
    else {
      const manifestObject = await this.env.CACHE_BUCKET.get(
        result.manifest_key,
      );
      if (!manifestObject)
        return failure(
          'publication_result_missing',
          'processor manifest is missing',
          503,
        );
      // Outside the try: a failed read is transient, and throwing retries the
      // step. Only content that was read and is wrong is a permanent failure.
      const manifestText = await manifestObject.text();
      try {
        manifest = parseJsonSchema(
          ChunkManifestSchema,
          JSON.parse(manifestText),
        );
      } catch {
        return failure('invalid_input', 'processor manifest is invalid', 422);
      }
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
    const { published_at: publishedAt } = this.storage.setResult(
      row.job_id,
      {
        manifest_key: result.manifest_key,
        deduplicated: result.deduplicated,
        published_at: now(),
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
      // The index shard rejects a retry whose mutation differs, so nothing in
      // this record may vary between attempts.
      last_accessed: publishedAt,
      created_at: publishedAt,
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
    // Not awaited: the bucket's lifecycle rule removes staging objects that
    // are left behind.
    void this.env.CACHE_BUCKET.delete(
      row.chunks_key ? [row.staging_key, row.chunks_key] : row.staging_key,
    ).catch((error: unknown) => console.error('staging cleanup failed', error));
    return ok();
  }
}
