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

/**
 * NARs up to this size are verified inside the Worker request that completes
 * them, so the client gets its answer at once. Larger ones are verified by the
 * upload workflow, which reads the same chunks. Measured CPU is about 6.4 ms
 * per MiB at worst, so a 256 MiB NAR takes about 1.6 s, well inside a
 * request's limit. See docs/COST_PLAN.md.
 */
const INLINE_VERIFY_MAX_NAR_SIZE = 256 * 1024 * 1024;
/** Smallest sane inline limit: 1 byte keeps the comparison well-defined. */
const INLINE_VERIFY_MIN_NAR_SIZE = 1;
/** Largest sane inline limit: above this a request risks its CPU/memory
 * bounds, so oversize work belongs to the upload workflow. */
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

/**
 * Canonical chunk-list bounds. `CHUNK_LIST_MAX_CHUNKS` must stay in sync
 * with `MAX_CHUNKS_PER_UPLOAD` in `encoded.ts`, which caps what `open`
 * accepts; both are asserted equal in `verify-stored.test.ts`.
 */
export const CHUNK_LIST_MAX_CHUNKS = 16384;
/**
 * Largest NAR the pipeline can verify or publish, in bytes (10 GiB). Must
 * stay in sync with the `nar_size` maximum in `schemas/api.json` (the
 * `EncodedUploadRequest` manifest), `schemas/process-job.json`, and
 * `schemas/manifest.json`, plus the open-time checks in `encoded.ts`
 * (`openEncoded`, before any quota reservation or allocation) and
 * `durable/session.ts` (`validateOpenInput`, at the DO boundary). A larger
 * NAR can never verify, so the Worker refuses it before reserving quota,
 * allocating an upload, or HEADing any chunks.
 */
export const MAX_NAR_SIZE = 10 * 1024 * 1024 * 1024;
/**
 * Upper bound for a chunk list payload. Each entry serializes to about 220
 * bytes, so 16384 entries need about 3.5 MiB; 256 bytes per chunk (4 MiB)
 * leaves headroom for JSON overhead. This fits the largest legal list: a
 * 10 GiB NAR (the process-job schema maximum) of 1 MiB chunks is about
 * 10240 entries (about 2.2 MiB). Enforced both as an R2 size pre-check and
 * as a UTF-8 byte-length check after the read, so an oversize list is
 * rejected before it is parsed and never held unbounded in memory.
 */
export const CHUNK_LIST_MAX_BYTES = CHUNK_LIST_MAX_CHUNKS * 256;
/**
 * Upper bound for a stored manifest payload. A manifest entry carries the
 * chunk-list fields plus compressed hash/size, so it serializes to about 300
 * bytes; 512 bytes per chunk (8 MiB for 16384 entries) leaves headroom while
 * still bounding memory. Enforced the same way as the chunk list: an R2 size
 * pre-check plus a UTF-8 byte-length check after the read, so an oversize
 * manifest is rejected before it is parsed.
 */
export const MANIFEST_MAX_BYTES = CHUNK_LIST_MAX_CHUNKS * 512;

export interface StoredNar {
  nar_hash: string;
  nar_size: number;
  chunks: { raw_hash: string; raw_size: number }[];
}

/** The chunk list a client-encoded upload leaves for the upload workflow. */
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
  // `readChunkList` caps the count for workflow loads, but this runs on
  // manifests too (the bench reads them directly), so enforce the same cap
  // here rather than looping over an unbounded attacker-controlled list.
  if (nar.chunks.length === 0)
    throw new InvalidEncodingError('chunk list is empty');
  if (nar.chunks.length > CHUNK_LIST_MAX_CHUNKS)
    throw new InvalidEncodingError(
      `chunk list has too many chunks (max ${CHUNK_LIST_MAX_CHUNKS})`,
    );
  // The verifier is constructed before the digest writers: its constructor
  // can throw (out of memory), and writers created before it would leak if it
  // did, since the try/finally below would never run.
  const verifier = new ChunkVerifier();
  const narDigest = new crypto.DigestStream('SHA-256');
  const fileDigest = new crypto.DigestStream('SHA-256');
  const narWriter = narDigest.getWriter();
  const fileWriter = fileDigest.getWriter();
  const refs: ChunkRef[] = [];
  let narSize: number;
  let fileSize = 0;
  try {
    // Serial on purpose: one chunk in memory at a time keeps large NARs
    // inside the Worker's memory limit.
    for (const chunk of nar.chunks) {
      // Rejected before any R2 read so a malformed hash is a permanent
      // encoding error without I/O, and never becomes an R2 key.
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
      // Chunks are protected by the upload's lease, so this is not a race.
      if (!object) throw new InvalidEncodingError(`chunk ${key} is missing`);
      // R2 reports the size in practice; when it does not (size undefined)
      // the read below still happens, and `verifier.chunk` enforces the same
      // cap on the bytes actually read.
      if (
        typeof object.size === 'number' &&
        object.size > CHUNK_MAX_COMPRESSED_SIZE
      )
        throw new InvalidEncodingError(`chunk ${key} is too large`);
      const compressed = new Uint8Array(await object.arrayBuffer());
      // Post-read: R2 reports the size in practice (checked above), but when
      // it does not — or when it lies — enforce the cap on the bytes actually
      // buffered before they reach the verifier.
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
    // Verification levels 2 and 3 delegate the NAR-size mapping to the
    // verifier, which maps a truncated size output to a permanent error.
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

/** Reads and checks the chunk list an upload left for the workflow. */
async function readChunkList(
  bucket: R2Bucket,
  job: ProcessJob,
): Promise<ChunkList> {
  const object = await bucket.get(job.chunks_key);
  if (!object) throw new Error(`chunk list ${job.chunks_key} is not visible`);
  // R2 reports the size in practice, so this pre-check avoids reading an
  // over-large list at all. When it does not (size undefined) the read still
  // happens, but the UTF-8 byte-length check right after it enforces the same
  // cap before the payload is parsed.
  if (typeof object.size === 'number' && object.size > CHUNK_LIST_MAX_BYTES)
    throw new InvalidEncodingError('chunk list is too large');
  const text = await object.text();
  // `text.length` counts UTF-16 units, while `object.size` counts bytes; use
  // the UTF-8 byte length so the two checks enforce the same limit. The encode
  // copies the whole list once, but the list is already in memory as `text`
  // and honest lists are bounded by CHUNK_LIST_MAX_BYTES (~4 MiB), so the
  // transient copy is bounded and streaming the length is unnecessary.
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
    // Rejected before the sum so a malformed size cannot skew it, and with
    // the same hash error the stored-chunk path reports.
    assertValidRawHash(chunk.raw_hash);
    if (
      !Number.isSafeInteger(chunk.raw_size) ||
      chunk.raw_size < 1 ||
      chunk.raw_size > CHUNK_MAX_RAW_SIZE ||
      chunk.key !== chunkKey(chunk.raw_hash)
    )
      throw new InvalidEncodingError('invalid chunk in chunk list');
  }
  // Duplicates would verify the same bytes twice and skew the NAR the
  // workflow publishes; the open path rejects them, and the workflow must
  // not trust a tampered list.
  if (
    new Set(list.chunks.map((chunk) => chunk.raw_hash)).size !==
    list.chunks.length
  )
    throw new InvalidEncodingError('chunk list declares duplicate chunks');
  if (
    list.chunks.reduce((sum, chunk) => sum + chunk.raw_size, 0) !==
    list.nar_size
  )
    throw new InvalidEncodingError('chunk sizes do not add up to the NAR size');
  return list;
}

/**
 * The upload workflow's verification of a NAR too large to check inline, or
 * of one whose inline publication was interrupted: the same checks over the
 * chunk list, then the manifest.
 */
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

/**
 * Writes `manifest` unless one already exists for its NAR, in which case the
 * stored manifest wins.
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
  // Same bounding as `readChunkList`: R2 reports the size in practice, so this
  // pre-check avoids reading an over-large manifest at all. When it does not
  // (size undefined) the read still happens, but the UTF-8 byte-length check
  // right after it enforces the same cap before the payload is parsed.
  if (typeof object.size === 'number' && object.size > MANIFEST_MAX_BYTES)
    throw new InvalidEncodingError(`stored manifest ${key} is too large`);
  const text = await object.text();
  // `text.length` counts UTF-16 units, while `object.size` counts bytes; use
  // the UTF-8 byte length so the two checks enforce the same limit.
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
  // The manifest schema has no maxItems, so cap a stale or compromised
  // manifest here before callers render it; verified manifests never exceed
  // `CHUNK_LIST_MAX_CHUNKS` (see `verifyStoredNar`).
  if (manifest.chunks.length > CHUNK_LIST_MAX_CHUNKS)
    throw new InvalidEncodingError(
      `stored manifest ${key} has too many chunks (max ${CHUNK_LIST_MAX_CHUNKS})`,
    );
  // The schema checks shapes, not content-addressing: validate each chunk
  // like the chunk-list path does, so a tampered manifest cannot smuggle in
  // a malformed hash (which must never become an R2 key downstream), a bad
  // size, a key pointing off its hash, or a duplicate that skews the NAR.
  // `verifyStoredNar` emits entries that always pass these; anything stored
  // by an older or compromised writer is re-checked here.
  const seen = new Set<string>();
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
    if (seen.has(chunk.raw_hash))
      throw new InvalidEncodingError(
        `stored manifest ${key} declares duplicate chunks`,
      );
    seen.add(chunk.raw_hash);
    rawTotal += chunk.raw_size;
  }
  if (rawTotal !== manifest.nar_size)
    throw new InvalidEncodingError(`stored manifest ${key} is invalid`);
  return manifest;
}
