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
  CHUNK_MAX_RAW_SIZE,
  InvalidEncodingError,
  chunkKey,
  verifyChunk,
} from './encoding';
import { validateUploadManifest } from './manifest';
import type {
  ChunkManifest,
  ProcessResult,
  UploadStateResponse,
} from './types';
import { writeChunkList } from './durable/session';
import { readManifest, storeManifest, verifyStoredNar } from './verify-stored';

type JobStub = DurableObjectStub<import('./durable/job').UploadJob>;

function invalid(message: string): DomainError {
  return new DomainError('validation_failed', message, 422);
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
  if (input.chunks.some((chunk) => chunk.raw_size > CHUNK_MAX_RAW_SIZE))
    throw invalid('chunk is larger than the encoding allows');
  const rawSize = input.chunks.reduce((sum, chunk) => sum + chunk.raw_size, 0);
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
  const fingerprint = JSON.stringify({ encoded: input });
  const { allocation, state } = await allocateUpload(
    env,
    cache,
    { operation_id: operationId, fingerprint, manifest: input.manifest },
    true,
  );
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
      staging_key: allocation.staging_key,
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
    // The client's encoder is broken; it falls back to a staging upload.
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
    const listed = writeChunkList(env.CACHE_BUCKET, plan.chunks_key, plan.nar);
    if (plan.kind === 'existing') {
      [manifest] = await Promise.all([
        readManifest(
          env.CACHE_BUCKET,
          plan.manifest_key,
          plan.nar.nar_hash,
          plan.nar.nar_size,
        ),
        listed,
      ]);
      result = { manifest_key: plan.manifest_key, deduplicated: true };
    } else {
      const [verified] = await Promise.all([
        verifyStoredNar(env.CACHE_BUCKET, plan.nar),
        listed,
      ]);
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
