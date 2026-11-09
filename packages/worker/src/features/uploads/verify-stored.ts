import { now } from '../../shared/clock';
import { ChunkManifestSchema, parseJsonSchema } from '../../shared/schemas';
import { ENCODING_ID } from '../cache/types';
import {
  CHUNK_MAX_COMPRESSED_SIZE,
  CHUNK_MAX_RAW_SIZE,
  chunkKey,
  manifestKey,
  nixBase32,
  sha256Nix,
} from './encoding';
import type {
  ChunkManifest,
  ChunkRef,
  ProcessJob,
  ProcessResult,
} from './types';
import {
  ChunkVerifier,
  InvalidEncodingError,
  assertValidRawHash,
} from './verifier';

const INLINE_VERIFY_MAX_NAR_SIZE = 256 * 1024 * 1024;
const INLINE_VERIFY_MIN_NAR_SIZE = 1;
const INLINE_VERIFY_UPPER_BOUND = 1024 * 1024 * 1024;

export function inlineVerifyLimit(
  env: Pick<Env, 'INLINE_VERIFY_MAX_NAR_SIZE'>,
): number {
  const raw = env.INLINE_VERIFY_MAX_NAR_SIZE;
  if (!raw) return INLINE_VERIFY_MAX_NAR_SIZE;
  const override = Number(raw);
  if (!Number.isSafeInteger(override)) return INLINE_VERIFY_MAX_NAR_SIZE;
  if (override < INLINE_VERIFY_MIN_NAR_SIZE) return INLINE_VERIFY_MIN_NAR_SIZE;
  if (override > INLINE_VERIFY_UPPER_BOUND) return INLINE_VERIFY_UPPER_BOUND;
  return override;
}

export const CHUNK_LIST_MAX_CHUNKS = 16384;
export const MAX_NAR_SIZE = 10 * 1024 * 1024 * 1024;
export const CHUNK_LIST_MAX_BYTES = CHUNK_LIST_MAX_CHUNKS * 256;
export const MANIFEST_MAX_BYTES = CHUNK_LIST_MAX_CHUNKS * 512;

export interface StoredNar {
  nar_hash: string;
  nar_size: number;
  chunks: { raw_hash: string; raw_size: number }[];
}

export interface ChunkList extends StoredNar {
  encoding_id: string;
  chunks: { raw_hash: string; raw_size: number; key: string }[];
}

export function chunkList(nar: StoredNar): ChunkList {
  return {
    encoding_id: ENCODING_ID,
    nar_hash: nar.nar_hash,
    nar_size: nar.nar_size,
    chunks: nar.chunks.map((chunk) => ({
      raw_hash: chunk.raw_hash,
      raw_size: chunk.raw_size,
      key: chunkKey(chunk.raw_hash),
    })),
  };
}

export async function verifyStoredNar(
  bucket: R2Bucket,
  nar: StoredNar,
): Promise<ChunkManifest> {
  if (nar.chunks.length === 0)
    throw new InvalidEncodingError('chunk list is empty');
  if (nar.chunks.length > CHUNK_LIST_MAX_CHUNKS)
    throw new InvalidEncodingError(
      `chunk list has too many chunks (max ${CHUNK_LIST_MAX_CHUNKS})`,
    );
  const verifier = new ChunkVerifier();
  const narDigest = new crypto.DigestStream('SHA-256');
  const fileDigest = new crypto.DigestStream('SHA-256');
  const narWriter = narDigest.getWriter();
  const fileWriter = fileDigest.getWriter();
  const refs: ChunkRef[] = [];
  let narSize: number;
  let fileSize = 0;
  try {
    for (const chunk of nar.chunks) {
      assertValidRawHash(chunk.raw_hash);
      if (
        !Number.isSafeInteger(chunk.raw_size) ||
        chunk.raw_size < 1 ||
        chunk.raw_size > CHUNK_MAX_RAW_SIZE
      )
        throw new InvalidEncodingError(
          `chunk ${chunk.raw_hash} has an invalid size`,
        );
      const key = chunkKey(chunk.raw_hash);
      const object = await bucket.get(key);
      if (!object) throw new InvalidEncodingError(`chunk ${key} is missing`);
      if (
        typeof object.size === 'number' &&
        object.size > CHUNK_MAX_COMPRESSED_SIZE
      )
        throw new InvalidEncodingError(`chunk ${key} is too large`);
      const compressed = new Uint8Array(await object.arrayBuffer());
      if (compressed.byteLength > CHUNK_MAX_COMPRESSED_SIZE)
        throw new InvalidEncodingError(`chunk ${key} is too large`);
      const raw = verifier.chunk(compressed, chunk.raw_size);
      const [rawHash, compressedHash] = await Promise.all([
        sha256Nix(raw),
        sha256Nix(compressed),
        narWriter.write(raw),
        fileWriter.write(compressed),
      ]);
      if (rawHash !== chunk.raw_hash)
        throw new InvalidEncodingError(`chunk ${key} does not match its key`);
      fileSize += compressed.length;
      refs.push({
        raw_hash: chunk.raw_hash,
        raw_size: chunk.raw_size,
        compressed_hash: compressedHash,
        compressed_size: compressed.length,
        key,
      });
    }
    narSize = verifier.finish();
  } finally {
    verifier.free();
    await Promise.all([
      narWriter.close().catch(() => undefined),
      fileWriter.close().catch(() => undefined),
    ]);
  }
  const narHash = `sha256:${nixBase32(new Uint8Array(await narDigest.digest))}`;
  if (narHash !== nar.nar_hash || narSize !== nar.nar_size)
    throw new InvalidEncodingError(
      'chunks do not match the declared NAR hash or size',
    );
  return {
    encoding_id: ENCODING_ID,
    nar_hash: nar.nar_hash,
    nar_size: nar.nar_size,
    file_hash: `sha256:${nixBase32(new Uint8Array(await fileDigest.digest))}`,
    file_size: fileSize,
    chunks: refs as ChunkManifest['chunks'],
    processing_version: 'worker-v2',
    created_at: now(),
  };
}

async function readChunkList(
  bucket: R2Bucket,
  job: ProcessJob,
): Promise<ChunkList> {
  const object = await bucket.get(job.chunks_key);
  if (!object) throw new Error(`chunk list ${job.chunks_key} is not visible`);
  if (typeof object.size === 'number' && object.size > CHUNK_LIST_MAX_BYTES)
    throw new InvalidEncodingError('chunk list is too large');
  const text = await object.text();
  if (new TextEncoder().encode(text).length > CHUNK_LIST_MAX_BYTES)
    throw new InvalidEncodingError('chunk list is too large');
  let list: ChunkList;
  try {
    list = JSON.parse(text) as ChunkList;
  } catch {
    throw new InvalidEncodingError('chunk list is not valid JSON');
  }
  if (
    list.encoding_id !== job.encoding_id ||
    list.nar_hash !== job.nar_hash ||
    list.nar_size !== job.nar_size
  )
    throw new InvalidEncodingError('chunk list does not match the upload');
  if (!Array.isArray(list.chunks))
    throw new InvalidEncodingError('chunk list chunks is not an array');
  if (list.chunks.length === 0)
    throw new InvalidEncodingError('chunk list is empty');
  if (list.chunks.length > CHUNK_LIST_MAX_CHUNKS)
    throw new InvalidEncodingError(
      `chunk list has too many chunks (max ${CHUNK_LIST_MAX_CHUNKS})`,
    );
  for (const chunk of list.chunks) {
    assertValidRawHash(chunk.raw_hash);
    if (
      !Number.isSafeInteger(chunk.raw_size) ||
      chunk.raw_size < 1 ||
      chunk.raw_size > CHUNK_MAX_RAW_SIZE ||
      chunk.key !== chunkKey(chunk.raw_hash)
    )
      throw new InvalidEncodingError('invalid chunk in chunk list');
  }
  const chunkSizes = new Map<string, number>();
  for (const chunk of list.chunks) {
    const known = chunkSizes.get(chunk.raw_hash);
    if (known === undefined) chunkSizes.set(chunk.raw_hash, chunk.raw_size);
    else if (known !== chunk.raw_size)
      throw new InvalidEncodingError('chunk list declares conflicting chunks');
  }
  if (
    list.chunks.reduce((sum, chunk) => sum + chunk.raw_size, 0) !==
    list.nar_size
  )
    throw new InvalidEncodingError('chunk sizes do not add up to the NAR size');
  return list;
}

export async function processUpload(
  bucket: R2Bucket,
  job: ProcessJob,
): Promise<ProcessResult> {
  const list = await readChunkList(bucket, job);
  const { result } = await storeManifest(
    bucket,
    await verifyStoredNar(bucket, list),
  );
  return result;
}

export async function storeManifest(
  bucket: R2Bucket,
  manifest: ChunkManifest,
): Promise<{ result: ProcessResult; manifest: ChunkManifest }> {
  const key = manifestKey(manifest.nar_hash);
  const created = await bucket.put(key, JSON.stringify(manifest), {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
  });
  if (created)
    return { result: { manifest_key: key, deduplicated: false }, manifest };
  return {
    result: { manifest_key: key, deduplicated: true },
    manifest: await readManifest(
      bucket,
      key,
      manifest.nar_hash,
      manifest.nar_size,
    ),
  };
}

export async function readManifest(
  bucket: R2Bucket,
  key: string,
  narHash: string,
  narSize: number,
): Promise<ChunkManifest> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`manifest ${key} is not yet visible`);
  if (typeof object.size === 'number' && object.size > MANIFEST_MAX_BYTES)
    throw new InvalidEncodingError(`stored manifest ${key} is too large`);
  const text = await object.text();
  if (new TextEncoder().encode(text).length > MANIFEST_MAX_BYTES)
    throw new InvalidEncodingError(`stored manifest ${key} is too large`);
  let manifest: ChunkManifest;
  try {
    manifest = parseJsonSchema(ChunkManifestSchema, JSON.parse(text));
  } catch {
    throw new InvalidEncodingError(`stored manifest ${key} is invalid`);
  }
  if (manifest.nar_hash !== narHash || manifest.nar_size !== narSize)
    throw new InvalidEncodingError(`stored manifest ${key} is for another NAR`);
  if (manifest.chunks.length > CHUNK_LIST_MAX_CHUNKS)
    throw new InvalidEncodingError(
      `stored manifest ${key} has too many chunks (max ${CHUNK_LIST_MAX_CHUNKS})`,
    );
  const seen = new Map<string, (typeof manifest.chunks)[number]>();
  let rawTotal = 0;
  for (const chunk of manifest.chunks) {
    assertValidRawHash(chunk.raw_hash);
    if (
      !Number.isSafeInteger(chunk.raw_size) ||
      chunk.raw_size < 1 ||
      chunk.raw_size > CHUNK_MAX_RAW_SIZE ||
      chunk.key !== chunkKey(chunk.raw_hash)
    )
      throw new InvalidEncodingError(`stored manifest ${key} is invalid`);
    try {
      assertValidRawHash(chunk.compressed_hash);
    } catch {
      throw new InvalidEncodingError(`stored manifest ${key} is invalid`);
    }
    if (
      !Number.isSafeInteger(chunk.compressed_size) ||
      chunk.compressed_size < 1 ||
      chunk.compressed_size > CHUNK_MAX_COMPRESSED_SIZE
    )
      throw new InvalidEncodingError(`stored manifest ${key} is invalid`);
    const known = seen.get(chunk.raw_hash);
    if (known !== undefined) {
      if (
        known.raw_size !== chunk.raw_size ||
        known.compressed_hash !== chunk.compressed_hash ||
        known.compressed_size !== chunk.compressed_size ||
        known.key !== chunk.key
      )
        throw new InvalidEncodingError(`stored manifest ${key} is invalid`);
    } else seen.set(chunk.raw_hash, chunk);
    rawTotal += chunk.raw_size;
  }
  if (rawTotal !== manifest.nar_size)
    throw new InvalidEncodingError(`stored manifest ${key} is invalid`);
  return manifest;
}
