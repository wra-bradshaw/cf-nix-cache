import type { Context } from 'hono';
import type { AppEnv } from '../runtime/http';
import type { CacheState, PathRecord } from '../../types';
import { ChunkManifestSchema, parseJsonSchema } from '../domain/validation';
import { planRange, parseRange } from './range';
import { indexShard } from '../../rpc';

export async function serveNarObject(
  c: Context<AppEnv>,
  cache: CacheState,
  storeHash: string,
  record: PathRecord,
  requestId: string,
): Promise<Response> {
  const request = c.req.raw;
  const object = await c.env.CACHE_BUCKET.get(record.manifest_key);
  if (!object)
    return Response.json(
      {
        code: 'corrupt_manifest',
        message: 'manifest is missing',
        request_id: requestId,
      },
      { status: 500 },
    );
  const manifest = parseJsonSchema(
    ChunkManifestSchema,
    await object.json<unknown>(),
  );
  const total = manifest.chunks.reduce(
    (sum, chunk) => sum + chunk.compressed_size,
    0,
  );
  if (total !== manifest.file_size)
    return Response.json(
      {
        code: 'corrupt_manifest',
        message: 'manifest chunk sizes do not match file size',
        request_id: requestId,
      },
      { status: 500 },
    );
  const range = parseRange(request.headers.get('range'), manifest.file_size);
  const plan = planRange(manifest.chunks, range);
  const status = range ? 206 : 200;
  const headers = new Headers({
    'content-type': 'application/x-nix-nar',
    'accept-ranges': 'bytes',
    'cache-control': cache.public
      ? // A store hash can be deliberately replaced through the control plane.
        // Keep this response's lifetime aligned with narinfo so a replacement
        // cannot leave clients serving an old NAR for a year.
        'public, max-age=300'
      : 'private, no-store',
    etag: `"${manifest.file_hash}"`,
    'content-length': String(
      range ? range.end - range.start + 1 : manifest.file_size,
    ),
  });
  if (range)
    headers.set(
      'content-range',
      `bytes ${range.start}-${range.end}/${manifest.file_size}`,
    );
  c.executionCtx.waitUntil(
    indexShard(c.env, cache.reference.incarnation, storeHash)
      .touch(storeHash)
      .catch((error) => console.error('cache touch failed', error)),
  );
  if (request.method === 'HEAD') return new Response(null, { status, headers });

  let planIndex = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          if (!reader) {
            const item = plan[planIndex++];
            if (!item) {
              controller.close();
              return;
            }
            const chunk = await c.env.CACHE_BUCKET.get(item.chunk.key, {
              range: { offset: item.offset, length: item.length },
            });
            if (!chunk?.body)
              throw new Error(`missing chunk ${item.chunk.key}`);
            reader = chunk.body.getReader();
          }
          const next = await reader.read();
          if (next.done) {
            reader.releaseLock();
            reader = null;
            continue;
          }
          controller.enqueue(next.value);
          return;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
      reader = null;
    },
  });
  return new Response(stream, { status, headers });
}
