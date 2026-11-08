/**
 * Verification benchmark Worker: a throwaway Worker with its own bucket
 * (see README.md). Chunks go in via `/put` (see `upload-nar.mts`), then
 * either `/verify` or the `VerifyWorkflow` runs the same verification the
 * upload workflow's step does; `/b1` times single-chunk decode plus hashing.
 *
 * Wall time does not advance during computation in a Worker, so the numbers
 * to read are each request's CPU time, from `wrangler tail --format json`.
 */
import {
  CHUNK_MAX_COMPRESSED_SIZE,
  CHUNK_MAX_RAW_SIZE,
  chunkKey,
  sha256Nix,
} from '../../packages/worker/src/features/uploads/encoding';
import { ENCODING_ID } from '../../packages/worker/src/features/cache/types';
import {
  InvalidEncodingError,
  assertValidRawHash,
  decodeChunk,
} from '../../packages/worker/src/features/uploads/verifier';
import {
  CHUNK_LIST_MAX_CHUNKS,
  verifyStoredNar,
} from '../../packages/worker/src/features/uploads/verify-stored';
import type { ChunkManifest } from '../../packages/worker/src/features/uploads/types';
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';

interface BenchEnv {
  BUCKET: R2Bucket;
  VERIFY: Workflow<Params>;
  /** Guards /put, the only route that writes. */
  BENCH_TOKEN: string;
}

interface Params {
  manifest: string;
}

async function loadManifest(
  bucket: R2Bucket,
  key: string,
): Promise<ChunkManifest> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`no manifest ${key}`);
  return object.json<ChunkManifest>();
}

/**
 * The `readChunkList` checks `verifyStoredNar` does not perform: the bench
 * reads manifests directly rather than through the upload workflow, so it
 * mirrors those checks here. `verifyStoredNar` re-derives each chunk's key
 * from its hash and compares the decoded NAR hash/size, but it never sees
 * the manifest's `encoding_id` or `key` fields and only catches a size-sum
 * mismatch after reading every chunk. Check all three up front instead, so
 * a crafted manifest fails before any chunk I/O, exactly as a workflow
 * load would.
 */
function assertBenchManifestShape(manifest: ChunkManifest): void {
  if (manifest.encoding_id !== ENCODING_ID)
    throw new InvalidEncodingError(
      'manifest encoding does not match this worker',
    );
  for (const chunk of manifest.chunks) {
    if (chunk.key !== chunkKey(chunk.raw_hash))
      throw new InvalidEncodingError('invalid chunk in manifest');
  }
  if (
    manifest.chunks.reduce((sum, chunk) => sum + chunk.raw_size, 0) !==
    manifest.nar_size
  )
    throw new InvalidEncodingError('chunk sizes do not add up to the NAR size');
}

/**
 * Reads at most `limit + 1` bytes, returning null when the body is larger.
 * The reader is cancelled on overflow so a huge body without (or with a
 * lying) `content-length` fails fast instead of filling memory before the
 * 413 above can fire.
 */
async function readBoundedBody(
  request: Request,
  limit: number,
): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Verification of a whole NAR inside one Workflow step, the way the upload
 * workflow would run it with `limits.cpu_ms` raised. The step's CPU time is in
 * the tail's `cpuTime`; the step result only reports what was verified.
 */
export class VerifyWorkflow extends WorkflowEntrypoint<BenchEnv, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    return step.do('verify', { retries: { limit: 0, delay: 0 } }, async () => {
      const manifest = await loadManifest(
        this.env.BUCKET,
        event.payload.manifest,
      );
      assertBenchManifestShape(manifest);
      const verified = await verifyStoredNar(this.env.BUCKET, manifest);
      return { nar_size: verified.nar_size, chunks: verified.chunks.length };
    });
  }
}

export default {
  async fetch(request: Request, env: BenchEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/put' && request.method === 'PUT') {
      if (
        !env.BENCH_TOKEN ||
        request.headers.get('authorization') !== `Bearer ${env.BENCH_TOKEN}`
      )
        return new Response('forbidden', { status: 403 });
      const key = url.searchParams.get('key');
      if (!key) return new Response('missing key', { status: 400 });
      // Throwaway bench bucket, but still cap one PUT so a misdirected
      // client cannot fill it unboundedly. The largest legal payload is a
      // max-compressed chunk (`CHUNK_MAX_COMPRESSED_SIZE`); bench manifests
      // are bounded by `CHUNK_LIST_MAX_BYTES` (~4 MiB) and so fit the same
      // cap. Stream with an early abort so a missing or lying
      // `content-length` cannot force the full body into memory before the
      // 413: at most one byte past the cap is ever buffered.
      const declared = request.headers.get('content-length');
      if (declared !== null) {
        const length = Number(declared);
        if (!Number.isSafeInteger(length) || length < 0)
          return new Response('invalid length', { status: 400 });
        if (length > CHUNK_MAX_COMPRESSED_SIZE)
          return new Response('too large', { status: 413 });
      }
      const body = await readBoundedBody(request, CHUNK_MAX_COMPRESSED_SIZE);
      if (body === null) return new Response('too large', { status: 413 });
      await env.BUCKET.put(key, body);
      return new Response(null, { status: 201 });
    }
    if (url.pathname === '/workflow' && request.method === 'POST') {
      const manifest = url.searchParams.get('manifest');
      if (!manifest) return new Response('missing manifest', { status: 400 });
      const instance = await env.VERIFY.create({
        params: { manifest },
      });
      return Response.json({ id: instance.id });
    }
    if (url.pathname.startsWith('/workflow/')) {
      const id = url.pathname.slice('/workflow/'.length);
      if (!id) return new Response('missing id', { status: 400 });
      const instance = await env.VERIFY.get(id);
      return Response.json(await instance.status());
    }
    if (url.pathname === '/manifest') {
      const key = url.searchParams.get('key');
      if (!key) return new Response('missing key', { status: 400 });
      const object = await env.BUCKET.get(key);
      return new Response(object?.body ?? null, { status: object ? 200 : 404 });
    }
    if (url.pathname === '/list') {
      const prefix = url.searchParams.get('prefix') ?? 'chunks/';
      const objects: { key: string; size: number }[] = [];
      let cursor: string | undefined;
      // Bound pagination like `/verify` bounds the chunk list
      // (`CHUNK_LIST_MAX_CHUNKS` in `verify-stored.ts`): without a cap a
      // bucket with an unbounded object count makes the bench loop over R2
      // `list` pages without end. One page holds 1000 keys, so this many
      // pages cover the largest legal chunk list.
      const maxPages = Math.ceil(CHUNK_LIST_MAX_CHUNKS / 1000);
      let pages = 0;
      do {
        if (pages >= maxPages)
          return new Response('too many objects', { status: 413 });
        pages += 1;
        const page = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
        objects.push(
          ...page.objects.map((o) => ({ key: o.key, size: o.size })),
        );
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return Response.json(objects);
    }
    // B1: decode one chunk and hash its raw and compressed bytes, `iters` times.
    if (url.pathname === '/b1') {
      const key = url.searchParams.get('key');
      if (!key) return new Response('missing key', { status: 400 });
      const iters = Number(url.searchParams.get('iters') ?? 1);
      if (!Number.isInteger(iters) || iters < 1 || iters > 1000)
        return new Response('invalid iters', { status: 400 });
      // Chunk keys are `chunks/<encoding>/<sha256-base32>.zst`; the raw hash
      // is the basename without `.zst`. Reject a malformed key (or hash)
      // with a 400 before any R2 read rather than hashing the wrong bytes.
      if (!key.endsWith('.zst'))
        return new Response('invalid key', { status: 400 });
      const rawHash = key.slice(key.lastIndexOf('/') + 1, -4);
      try {
        assertValidRawHash(rawHash);
      } catch {
        return new Response('invalid raw hash', { status: 400 });
      }
      const object = await env.BUCKET.get(key);
      if (!object) return new Response('missing', { status: 404 });
      const compressed = new Uint8Array(await object.arrayBuffer());
      let rawSize = 0;
      // The raw size crosses into wasm as a 32-bit integer, so reject
      // NaN, non-integers, negatives, and oversize values with a 400 before
      // decodeChunk maps them to InvalidEncodingError. The limit is the
      // single source from encoding.ts, which mirrors
      // CHUNK_MAX_RAW_SIZE in crates/verify/src/lib.rs.
      const size = Number(url.searchParams.get('raw'));
      if (!Number.isInteger(size) || size < 1 || size > CHUNK_MAX_RAW_SIZE)
        return new Response('invalid raw size', { status: 400 });
      for (let i = 0; i < iters; i += 1) {
        const raw = decodeChunk(compressed, size);
        rawSize = raw.length;
        if ((await sha256Nix(raw)) !== rawHash) throw new Error('raw hash');
        await sha256Nix(compressed);
      }
      return Response.json({
        compressed: compressed.length,
        raw: rawSize,
        iters,
      });
    }
    // L2+L3 as completion runs them. The chunk-count cap mirrors
    // `readChunkList` in `verify-stored.ts`: without it a crafted manifest
    // could make the bench loop over an unbounded chunk list. The
    // encoding-id, key-shape, and size-sum checks mirror `readChunkList` too
    // (see `assertBenchManifestShape`): the bench reads manifests directly
    // rather than through the workflow, so without them a manifest with the
    // wrong encoding, forged keys, or sizes that do not sum to the NAR size
    // would still reach `verifyStoredNar`, which re-derives keys and only
    // catches the sum after reading every chunk. Invalid content maps
    // to 400 like the `/b1` bad-input paths, so bench misuse does not read
    // as a server failure.
    if (url.pathname === '/verify') {
      const manifestKey = url.searchParams.get('manifest');
      if (!manifestKey)
        return new Response('missing manifest', { status: 400 });
      const object = await env.BUCKET.get(manifestKey);
      if (!object) return new Response('missing', { status: 404 });
      // A malformed stored payload is bench misuse, not a server failure:
      // map bad JSON (and a null/non-object decoded value, whose `.chunks`
      // read would otherwise throw a TypeError → 500) to a 400 like the
      // invalid-encoding paths below.
      let manifest: ChunkManifest;
      try {
        manifest = await object.json<ChunkManifest>();
      } catch {
        return new Response('invalid manifest', { status: 400 });
      }
      if (
        !manifest ||
        typeof manifest !== 'object' ||
        !Array.isArray(manifest.chunks)
      )
        return new Response('invalid manifest', { status: 400 });
      if (manifest.chunks.length === 0)
        return new Response('empty chunk list', { status: 400 });
      if (manifest.chunks.length > CHUNK_LIST_MAX_CHUNKS)
        return new Response('too many chunks', { status: 400 });
      try {
        assertBenchManifestShape(manifest);
        await verifyStoredNar(env.BUCKET, {
          nar_hash: manifest.nar_hash,
          nar_size: manifest.nar_size,
          chunks: manifest.chunks,
        });
      } catch (error) {
        if (error instanceof InvalidEncodingError)
          return new Response('invalid encoding', { status: 400 });
        throw error;
      }
      return Response.json({
        nar_size: manifest.nar_size,
        chunks: manifest.chunks.length,
      });
    }
    return new Response('not found', { status: 404 });
  },
};
