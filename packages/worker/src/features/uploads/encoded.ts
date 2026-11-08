import { DomainError } from '../../shared/errors';
import { idStub, unwrapRpc } from '../../shared/rpc';
import { coordinator } from '../cache/stubs';
import type { CacheState } from '../cache/types';
import type {
  EncodedUploadRequest,
  EncodedUploadResponse,
} from '../../generated/contracts';
import { allocateUpload } from './allocate';
import {
  CHUNK_MAX_COMPRESSED_SIZE,
  CHUNK_MAX_RAW_SIZE,
  chunkKey,
  verifyChunk,
} from './encoding';
import { InvalidEncodingError, RAW_HASH } from './verifier';
import { validateUploadManifest } from './manifest';
import type {
  ChunkManifest,
  ProcessResult,
  UploadStateResponse,
} from './types';
import { writeChunkList } from './durable/session';
import {
  MAX_NAR_SIZE,
  readManifest,
  storeManifest,
  verifyStoredNar,
} from './verify-stored';

type JobStub = DurableObjectStub<import('./durable/job').UploadJob>;

function invalid(message: string): DomainError {
  return new DomainError('validation_failed', message, 422);
}

/**
 * Most chunks an upload may declare. 16384 chunks of 16 MiB could in theory
 * cover 256 GiB, but the effective ceiling is the 10 GiB NAR maximum in
 * `schemas/process-job.json`: at the 1 MiB minimum chunk size that is about
 * 10240 chunks, so 16384 leaves headroom. It matches
 * `CHUNK_LIST_MAX_CHUNKS` in `verify-stored.ts`, which must accept the list.
 */
export const MAX_CHUNKS_PER_UPLOAD = 16384;

/**
 * Idempotency fingerprint for an encoded upload. The verbatim JSON of up to
 * 16384 chunks is megabytes (about 220 bytes per chunk), too large to store
 * in the allocation and job rows on every push, so store the sha256 hex of
 * the canonical JSON instead. Equality still detects retried metadata
 * changes; collisions are negligible. No backward compatibility by design:
 * only exact hex equality joins a retry, anything else is an
 * idempotency conflict.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value))
    return `[${value
      .map((item) =>
        item === undefined || typeof item === 'function' || typeof item === 'symbol'
          ? 'null'
          : (stableStringify(item) ?? 'null'),
      )
      .join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined && typeof v !== 'function' && typeof v !== 'symbol',
  );
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(',')}}`;
}

export async function fingerprintForEncodedUpload(
  input: EncodedUploadRequest,
): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify({ encoded: input }));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** Opens a client-encoded upload and reports the chunks the server lacks. */
export async function openEncoded(
  env: Env,
  cache: CacheState,
  operationId: string,
  input: EncodedUploadRequest,
): Promise<EncodedUploadResponse> {
  validateUploadManifest(input.manifest);
  if (input.manifest.cache !== cache.name)
    throw invalid('upload belongs to another cache');
  if (input.chunks.length === 0 || input.chunks.length > MAX_CHUNKS_PER_UPLOAD)
    throw invalid('upload declares an invalid number of chunks');
  if (
    input.chunks.some(
      (chunk) =>
        !Number.isSafeInteger(chunk.raw_size) ||
        chunk.raw_size < 1 ||
        chunk.raw_size > CHUNK_MAX_RAW_SIZE,
    )
  )
    throw invalid('chunk is larger than the encoding allows');
  if (
    input.chunks.some(
      (chunk) =>
        !Number.isSafeInteger(chunk.compressed_size) ||
        chunk.compressed_size < 1 ||
        chunk.compressed_size > CHUNK_MAX_COMPRESSED_SIZE,
    )
  )
    throw invalid('chunk is larger than the encoding allows');
  if (
    input.chunks.some(
      (chunk) =>
        typeof chunk.compressed_hash !== 'string' ||
        !RAW_HASH.test(chunk.compressed_hash),
    )
  )
    throw invalid('chunk has an invalid compressed hash');
  if (
    input.chunks.some(
      (chunk) =>
        typeof chunk.raw_hash !== 'string' || !RAW_HASH.test(chunk.raw_hash),
    )
  )
    throw invalid('chunk has an invalid raw hash');
  if (
    new Set(input.chunks.map((chunk) => chunk.raw_hash)).size !==
    input.chunks.length
  )
    throw invalid('upload declares duplicate chunks');
  const rawSize = input.chunks.reduce((sum, chunk) => sum + chunk.raw_size, 0);
  // Upper bound is `MAX_NAR_SIZE` (the process-job schema maximum): larger
  // NARs can never verify, so refuse before reserving quota or allocating an
  // upload for one. The schema already caps this, but the Worker must not
  // trust it — otherwise a schema change alone could allocate uploads the
  // session DO would reject at `open`.
  if (
    !Number.isSafeInteger(input.manifest.nar_size) ||
    input.manifest.nar_size < 1 ||
    input.manifest.nar_size > MAX_NAR_SIZE
  )
    throw invalid('upload declares an invalid NAR size');
  if (rawSize !== input.manifest.nar_size)
    throw invalid('chunk sizes do not add up to the NAR size');
  const compressedSize = input.chunks.reduce(
    (sum, chunk) => sum + chunk.compressed_size,
    0,
  );
  // Publication reserves quota for real; this only refuses early an upload
  // that would certainly be refused at the end.
  unwrapRpc(
    await coordinator(env, cache.reference).checkQuota({
      delta: compressedSize,
    }),
  );
  // Hashed (not verbatim): the JSON of 16384 chunks is megabytes, and the
  // fingerprint is stored in both the allocation and job rows.
  const fingerprint = await fingerprintForEncodedUpload(input);
  const { allocation, state } = await allocateUpload(env, cache, {
    operation_id: operationId,
    fingerprint,
    manifest: input.manifest,
  });
  if (allocation.merged)
    return {
      id: allocation.id,
      status: state!,
      error: null,
      merged: true,
      missing_chunks: [],
    };
  const opened = unwrapRpc(
    await idStub(env.UPLOAD_JOB, allocation.id).openSession({
      job_id: allocation.id,
      cache: cache.name,
      cache_id: cache.reference.id,
      incarnation: cache.reference.incarnation,
      chunks_key: allocation.chunks_key,
      manifest: input.manifest,
      compressed_size: compressedSize,
      idempotency_key: operationId,
      fingerprint,
      chunks: input.chunks,
    }),
  );
  return {
    id: allocation.id,
    status: opened.state,
    error: opened.error,
    merged: false,
    missing_chunks: opened.missing_chunks,
  };
}

/**
 * Checks an uploaded chunk against the session (verification level 1) and
 * only then writes it to its content-addressed key.
 */
export async function storeChunk(
  env: Env,
  job: JobStub,
  rawHash: string,
  compressed: Uint8Array,
): Promise<void> {
  const claim = unwrapRpc(await job.chunkClaim(rawHash));
  if (claim.present) return;
  try {
    await verifyChunk(compressed, claim);
  } catch (error) {
    if (!(error instanceof InvalidEncodingError)) throw error;
    // The client's encoder is broken, or the chunk was corrupted on the way.
    unwrapRpc(await job.reject(`chunk ${rawHash}: ${error.message}`));
    throw new DomainError('invalid_chunk', error.message, 422);
  }
  await env.CACHE_BUCKET.put(chunkKey(rawHash), compressed, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/zstd' },
  });
  unwrapRpc(await job.chunkStored(rawHash));
}

/** Verifies and publishes a client-encoded upload whose chunks are stored. */
export async function completeEncoded(
  env: Env,
  job: JobStub,
): Promise<UploadStateResponse> {
  const plan = unwrapRpc(await job.beginComplete());
  if (plan.kind === 'done') return plan.state;
  let result: ProcessResult;
  let manifest: ChunkManifest;
  try {
    if (plan.kind === 'existing') {
      // The open-time manifest hit already probed a canary sample (see
      // `checkPresent`): the lease held since before the manifest HEAD plus
      // GC's manifests-first sweep ordering (GcLedger.nextDeletions orders
      // manifests before chunks) keeps the referenced chunks live, and
      // `readManifest` below re-validates the manifest itself (size caps,
      // schema, chunk key/size/duplicate checks) before it is trusted.
      manifest = await readManifest(
        env.CACHE_BUCKET,
        plan.manifest_key,
        plan.nar.nar_hash,
        plan.nar.nar_size,
      );
      await writeChunkList(env.CACHE_BUCKET, plan.chunks_key, plan.nar);
      result = { manifest_key: plan.manifest_key, deduplicated: true };
    } else {
      const verified = await verifyStoredNar(env.CACHE_BUCKET, plan.nar);
      await writeChunkList(env.CACHE_BUCKET, plan.chunks_key, plan.nar);
      // A manifest stored by an earlier upload of the NAR wins.
      ({ result, manifest } = await storeManifest(env.CACHE_BUCKET, verified));
    }
  } catch (error) {
    if (error instanceof InvalidEncodingError)
      return unwrapRpc(await job.reject(error.message));
    throw error;
  }
  return unwrapRpc(await job.publishVerified(result, manifest));
}
