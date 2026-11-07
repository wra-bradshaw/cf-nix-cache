/**
 * Benchmarks B1 and B2 from docs/COST_PLAN.md, deployed as a throwaway Worker
 * bound to a bucket that already holds chunks (see README.md).
 *
 * Wall time does not advance during computation in a Worker, so the numbers
 * to read are each request's CPU time, from `wrangler tail --format json`.
 */
import {
  decodeChunk,
  sha256Nix,
} from '../../packages/worker/src/features/uploads/encoding';
import { NarValidator } from '../../packages/worker/src/features/uploads/nar-validator';
import { verifyStoredNar } from '../../packages/worker/src/features/uploads/verify-stored';
import type { ChunkManifest } from '../../packages/worker/src/features/uploads/types';

interface BenchEnv {
  BUCKET: R2Bucket;
}

export default {
  async fetch(request: Request, env: BenchEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/manifest') {
      const object = await env.BUCKET.get(url.searchParams.get('key')!);
      return new Response(object?.body ?? null, { status: object ? 200 : 404 });
    }
    if (url.pathname === '/list') {
      const prefix = url.searchParams.get('prefix') ?? 'chunks/';
      const objects: { key: string; size: number }[] = [];
      let cursor: string | undefined;
      do {
        const page = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
        objects.push(...page.objects.map((o) => ({ key: o.key, size: o.size })));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return Response.json(objects);
    }
    // B1: decode one chunk and hash its raw and compressed bytes, `iters` times.
    if (url.pathname === '/b1') {
      const key = url.searchParams.get('key')!;
      const iters = Number(url.searchParams.get('iters') ?? 1);
      const object = await env.BUCKET.get(key);
      if (!object) return new Response('missing', { status: 404 });
      const compressed = new Uint8Array(await object.arrayBuffer());
      const rawHash = key.slice(key.lastIndexOf('/') + 1, -4);
      let rawSize = 0;
      const size = Number(url.searchParams.get('raw'));
      for (let i = 0; i < iters; i += 1) {
        const raw = decodeChunk(compressed, size);
        rawSize = raw.length;
        if ((await sha256Nix(raw)) !== rawHash) throw new Error('raw hash');
        await sha256Nix(compressed);
      }
      return Response.json({ compressed: compressed.length, raw: rawSize, iters });
    }
    // B2: NAR structural validation alone, over the decoded chunks of a NAR.
    if (url.pathname === '/b2') {
      const manifest = await (await env.BUCKET.get(url.searchParams.get('manifest')!))!.json<ChunkManifest>();
      const raws: Uint8Array[] = [];
      for (const chunk of manifest.chunks) {
        const object = await env.BUCKET.get(chunk.key);
        raws.push(decodeChunk(new Uint8Array(await object!.arrayBuffer()), chunk.raw_size));
      }
      // Everything above is I/O and decoding; the validation is measured by
      // the difference between this route with and without `validate`.
      if (url.searchParams.get('validate') === '1') {
        const validator = new NarValidator();
        for (const raw of raws) validator.push(raw);
        validator.finish();
      }
      return Response.json({ nar_size: manifest.nar_size, chunks: raws.length });
    }
    // L2+L3 as completion runs them.
    if (url.pathname === '/verify') {
      const manifest = await (await env.BUCKET.get(url.searchParams.get('manifest')!))!.json<ChunkManifest>();
      await verifyStoredNar(env.BUCKET, {
        nar_hash: manifest.nar_hash,
        nar_size: manifest.nar_size,
        chunks: manifest.chunks,
      });
      return Response.json({ nar_size: manifest.nar_size, chunks: manifest.chunks.length });
    }
    return new Response('not found', { status: 404 });
  },
};

