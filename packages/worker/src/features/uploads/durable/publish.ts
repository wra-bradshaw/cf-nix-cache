import { now } from '../../../shared/clock';
import { DomainError } from '../../../shared/errors';
import { ApiCallError, failure, ok, type RpcResult } from '../../../shared/rpc';
import { ChunkManifestSchema, parseJsonSchema } from '../../../shared/schemas';
import { MANIFEST_MAX_BYTES } from '../verify-stored';
import { publicationFor } from '../../cache/publication-adapters';
import { PublicationError } from '../../cache/publication-protocol';
import { getCache } from '../../cache/resolve-cache';
import type { CacheState, PathRecord } from '../../cache/types';
import { renderNarInfo } from '../../nix/narinfo';
import type { ChunkManifest, ProcessResult } from '../types';
import { UploadStorage, type SetResultOutcome } from './storage';

export class UploadPublisher {
  constructor(
    private readonly env: Env,
    private readonly storage: UploadStorage,
  ) {}

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
          'verified manifest is missing',
          503,
        );
      if (
        typeof manifestObject.size === 'number' &&
        manifestObject.size > MANIFEST_MAX_BYTES
      )
        return failure('invalid_input', 'verified manifest is too large', 422);
      const manifestText = await manifestObject.text();
      if (new TextEncoder().encode(manifestText).length > MANIFEST_MAX_BYTES)
        return failure('invalid_input', 'verified manifest is too large', 422);
      try {
        manifest = parseJsonSchema(
          ChunkManifestSchema,
          JSON.parse(manifestText),
        );
      } catch {
        return failure('invalid_input', 'verified manifest is invalid', 422);
      }
    }
    if (
      manifest.nar_hash !== row.manifest.nar_hash ||
      manifest.nar_size !== row.manifest.nar_size
    )
      return failure(
        'invalid_input',
        'verified manifest does not match upload metadata',
        422,
      );
    const outcome: SetResultOutcome = this.storage.setResult(
      row.job_id,
      {
        manifest_key: result.manifest_key,
        deduplicated: result.deduplicated,
        published_at: now(),
      },
      ['PROCESSING', 'PUBLISHING'],
      'PUBLISHING',
    );
    const { published_at: publishedAt, wrote } = outcome;
    if (!wrote) {
      const lost = this.storage.row();
      if (!lost) return failure('not_found', 'upload not found', 404);
      if (lost.state === 'READY') return ok();
      return failure(
        'invalid_transition',
        `upload is ${lost.state}, not publishing`,
        409,
      );
    }
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
      last_accessed: publishedAt,
      created_at: publishedAt,
    };
    record.narinfo = await renderNarInfo(this.env, record, manifest);
    const active = this.storage.row();
    if (!active) return failure('not_found', 'upload not found', 404);
    if (active.state === 'READY') return ok();
    if (active.state !== 'PUBLISHING')
      return failure(
        'invalid_transition',
        `upload is ${active.state}, not publishing`,
        409,
      );
    try {
      await publicationFor(this.env, cache, row.manifest.store_hash).execute(
        `publish:${row.job_id}`,
        { kind: 'upsert', record },
      );
    } catch (error) {
      if (error instanceof PublicationError)
        return failure(
          'publication_failed',
          error.message,
          error.retryable ? 503 : 409,
        );
      throw error;
    }
    if (!this.storage.setState(row.job_id, ['PUBLISHING'], 'READY')) {
      const current = this.storage.row();
      if (current?.state === 'READY') {
        console.info(
          `upload ${row.job_id} left PUBLISHING before READY was recorded`,
        );
      } else if (!current) {
        return failure('not_found', 'upload not found', 404);
      } else {
        console.info(
          `upload ${row.job_id} left PUBLISHING (now ${current.state}) before READY was recorded`,
        );
        return failure(
          'invalid_transition',
          `upload is ${current.state}, not publishing`,
          409,
        );
      }
    }
    void this.env.CACHE_BUCKET.delete(row.chunks_key).catch((error: unknown) =>
      console.error('staging cleanup failed', error),
    );
    return ok();
  }
}
