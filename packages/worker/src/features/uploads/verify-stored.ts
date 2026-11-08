import { now } from '../../shared/clock';
import { ChunkManifestSchema, parseJsonSchema } from '../../shared/schemas';
import { ENCODING_ID } from '../cache/types';
import {
  CHUNK_MAX_COMPRESSED_SIZE,
  InvalidEncodingError,
  chunkKey,
  decodeChunk,
  manifestKey,
  nixBase32,
  sha256Nix,
} from './encoding';
import { InvalidNarError, NarValidator } from './nar-validator';
import type { ChunkManifest, ChunkRef, ProcessResult } from './types';

/**
 * NARs up to this size are verified inside the Worker request that completes
 * them. Larger ones go to the processor container, which reads the same
 * chunks. Benchmarks B1 and B2 measured at most about 50 ms of CPU per MiB
 * (compressible chunks of a NAR of many small files), so this stays near
 * 13 s, under the default 30 s CPU limit. See docs/COST_PLAN.md.
 */
const INLINE_VERIFY_MAX_NAR_SIZE = 256 * 1024 * 1024;

export function inlineVerifyLimit(
  env: Pick<Env, 'INLINE_VERIFY_MAX_NAR_SIZE'>,
): number {
  const override = Number(env.INLINE_VERIFY_MAX_NAR_SIZE);
  return env.INLINE_VERIFY_MAX_NAR_SIZE && Number.isSafeInteger(override)
    ? override
    : INLINE_VERIFY_MAX_NAR_SIZE;
}

export interface StoredNar {
  nar_hash: string;
  nar_size: number;
  chunks: { raw_hash: string; raw_size: number }[];
}

/** The chunk list a client-encoded upload leaves for the processor. */
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

/**
 * Verification levels 2 and 3 over chunks already in the bucket: their
 * concatenation is a structurally valid NAR with the declared hash and size.
 * The manifest is built from the stored bytes, so its FileHash is right
 * whichever zstd build compressed them.
 */
export async function verifyStoredNar(
  bucket: R2Bucket,
  nar: StoredNar,
): Promise<ChunkManifest> {
  const narDigest = new crypto.DigestStream('SHA-256');
  const fileDigest = new crypto.DigestStream('SHA-256');
  const narWriter = narDigest.getWriter();
  const fileWriter = fileDigest.getWriter();
  const validator = new NarValidator();
  const refs: ChunkRef[] = [];
  let narSize = 0;
  let fileSize = 0;
  try {
    for (const chunk of nar.chunks) {
      const key = chunkKey(chunk.raw_hash);
      const object = await bucket.get(key);
      // Chunks are protected by the upload's lease, so this is not a race.
      if (!object) throw new InvalidEncodingError(`chunk ${key} is missing`);
      if (object.size > CHUNK_MAX_COMPRESSED_SIZE)
        throw new InvalidEncodingError(`chunk ${key} is too large`);
      const compressed = new Uint8Array(await object.arrayBuffer());
      const raw = decodeChunk(compressed, chunk.raw_size);
      if ((await sha256Nix(raw)) !== chunk.raw_hash)
        throw new InvalidEncodingError(`chunk ${key} does not match its key`);
      validator.push(raw);
      await narWriter.write(raw);
      await fileWriter.write(compressed);
      narSize += raw.length;
      fileSize += compressed.length;
      refs.push({
        raw_hash: chunk.raw_hash,
        raw_size: chunk.raw_size,
        compressed_hash: await sha256Nix(compressed),
        compressed_size: compressed.length,
        key,
      });
    }
    validator.finish();
  } catch (error) {
    if (error instanceof InvalidNarError)
      throw new InvalidEncodingError(`invalid NAR archive: ${error.message}`);
    throw error;
  } finally {
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
    processing_version: 'worker-inline-v1',
    created_at: now(),
  };
}

/**
 * Writes `manifest` unless one already exists for its NAR, in which case the
 * stored manifest wins, as it does in the processor.
 */
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

/** Reads and checks a stored manifest; a bad one is a permanent failure. */
export async function readManifest(
  bucket: R2Bucket,
  key: string,
  narHash: string,
  narSize: number,
): Promise<ChunkManifest> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`manifest ${key} is not yet visible`);
  const text = await object.text();
  let manifest: ChunkManifest;
  try {
    manifest = parseJsonSchema(ChunkManifestSchema, JSON.parse(text));
  } catch {
    throw new InvalidEncodingError(`stored manifest ${key} is invalid`);
  }
  if (manifest.nar_hash !== narHash || manifest.nar_size !== narSize)
    throw new InvalidEncodingError(`stored manifest ${key} is for another NAR`);
  return manifest;
}
