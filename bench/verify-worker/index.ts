/**
 * Throwaway bench Worker (own bucket; see README.md). `/put` ingests chunks,
 * then `/verify` or `VerifyWorkflow` runs the upload workflow's verification.
 *
 * Wall time freezes during compute, so read per-request CPU time via
 * `wrangler tail --format json`.
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
 * The bench reads manifests directly, so it mirrors the workflow's
 * `readChunkList` checks here and fails crafted manifests before any chunk I/O.
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
 * Reads at most `limit + 1` bytes, cancelling the reader on overflow so a
 * lying `content-length` fails fast instead of filling memory.
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

/** Whole-NAR verification in one Workflow step; read the step's CPU time. */
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
      // Cap one PUT; stream with early abort so a lying `content-length`
      // cannot force the full body into memory before the 413.
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
      // Bound pages: without a cap an unbounded bucket makes the R2 `list`
      // loop run without end.
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
    if (url.pathname === '/b1') {
      const key = url.searchParams.get('key');
      if (!key) return new Response('missing key', { status: 400 });
      const iters = Number(url.searchParams.get('iters') ?? 1);
      if (!Number.isInteger(iters) || iters < 1 || iters > 1000)
        return new Response('invalid iters', { status: 400 });
      // Reject a malformed key before any R2 read.
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
      // Raw size crosses into wasm as a 32-bit int, so reject non-integers
      // and oversize values with a 400 before decode.
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
    // Same guards as completion: bound the chunk list and mirror
    // `readChunkList` so misuse maps to 400, not a server failure.
    if (url.pathname === '/verify') {
      const manifestKey = url.searchParams.get('manifest');
      if (!manifestKey)
        return new Response('missing manifest', { status: 400 });
      const object = await env.BUCKET.get(manifestKey);
      if (!object) return new Response('missing', { status: 404 });
      // Bench misuse, not a server failure: map bad JSON to a 400.
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
