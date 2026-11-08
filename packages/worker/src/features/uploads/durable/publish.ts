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
          'verified manifest is missing',
          503,
        );
      // Outside the try: a failed read is transient, and throwing retries the
      // step. Only content that was read and is wrong is a permanent failure.
      // Bounded like `readManifest`: R2 reports the size in practice, so this
      // pre-check avoids reading an over-large manifest at all; when it does
      // not (size undefined) the read still happens, but the UTF-8
      // byte-length check right after it enforces the same cap before the
      // payload is parsed.
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
    // `setResult` is conditional and reports whether it wrote via `wrote`
    // (an explicit `false` means the row had already left PROCESSING /
    // PUBLISHING, e.g. a concurrent fail won). The `wrote` check short-circuits
    // the lost write below, while the re-read still guards the awaits after a
    // successful write.
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
      // The index shard rejects a retry whose mutation differs, so nothing in
      // this record may vary between attempts.
      last_accessed: publishedAt,
      created_at: publishedAt,
    };
    record.narinfo = await renderNarInfo(this.env, record, manifest);
    // The awaits above (cache lookup, manifest read, signing) let a
    // concurrent fail()/abort() move the row out of PUBLISHING even after a
    // successful `setResult` write, so re-read the row here and skip the index
    // upsert unless the upload is still publishing. A READY row means a
    // concurrent retry already published this record. `setResult` moves
    // PROCESSING to PUBLISHING when it writes, so only PUBLISHING (or a
    // concurrent READY) can be seen here.
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
    // A concurrent publish retry may have recorded READY first; the record
    // is identical either way (setResult keeps the first published_at), so a
    // lost write to READY is idempotent. Any other state means a concurrent
    // fail() moved the row out of PUBLISHING: report it instead of
    // returning success for a FAILED upload.
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
    // Not awaited: the bucket's lifecycle rule removes staging objects that
    // are left behind.
    void this.env.CACHE_BUCKET.delete(row.chunks_key).catch((error: unknown) =>
      console.error('staging cleanup failed', error),
    );
    return ok();
  }
}
