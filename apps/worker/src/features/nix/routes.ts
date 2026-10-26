import { Hono, type Context } from 'hono';
import { assertCacheName } from '../domain/validation';
import type { PathRecord } from '../../types';
import type { AppEnv } from '../runtime/http';
import { authFor, getCache, getPath, isNotFound } from '../cache/directory';
import { serveNarObject } from './object';

export const nixRoutes = new Hono<AppEnv>();

async function nixHandler(c: Context<AppEnv>): Promise<Response> {
  const request = c.req.raw;
  const requestId = c.get('requestId');
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return Response.json(
      {
        code: 'method_not_allowed',
        message: 'method not allowed',
        request_id: requestId,
      },
      { status: 405 },
    );
  const cacheName = c.req.param('cache') ?? '';
  assertCacheName(cacheName);
  const suffix = c.req.param('path') ?? '';
  const cache = await getCache(c.env, cacheName);
  if (cache.lifecycle === 'DELETING')
    return Response.json(
      {
        code: 'cache_deleting',
        message: 'cache is being deleted',
        request_id: requestId,
      },
      { status: 410 },
    );
  if (cache.lifecycle !== 'ACTIVE')
    return Response.json(
      {
        code: 'cache_unavailable',
        message: 'cache is not active',
        request_id: requestId,
      },
      { status: 503 },
    );
  const narInfo = /^([0-9abcdfghijklmnpqrsvwxyz]{32})\.narinfo$/.exec(suffix);
  const narObject = /^nar\/([0-9abcdfghijklmnpqrsvwxyz]{32})\.nar\.zst$/.exec(
    suffix,
  );
  if (suffix === 'nix-cache-info') {
    await authFor(request, c.env, cache, 'pull');
    return new Response(
      request.method === 'HEAD'
        ? null
        : 'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n',
      {
        headers: {
          'content-type': 'text/plain',
          'cache-control': cache.public
            ? 'public, max-age=300'
            : 'private, no-store',
        },
      },
    );
  }
  if (!narInfo && !narObject)
    return Response.json(
      {
        code: 'not_found',
        message: 'path not found',
        request_id: requestId,
      },
      { status: 404 },
    );
  const storeHash = (narInfo ?? narObject)![1];
  await authFor(request, c.env, cache, 'pull');
  let record: PathRecord;
  try {
    record = await getPath(c.env, cache, storeHash);
  } catch (error) {
    if (isNotFound(error))
      return Response.json(
        {
          code: 'not_found',
          message: 'path not found',
          request_id: requestId,
        },
        { status: 404 },
      );
    throw error;
  }
  if (narInfo)
    return new Response(request.method === 'HEAD' ? null : record.narinfo, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        etag: `"${record.file_hash}"`,
        'cache-control': cache.public
          ? 'public, max-age=300'
          : 'private, no-store',
      },
    });
  return serveNarObject(c, cache, storeHash, record, requestId);
}

nixRoutes.all('/cache/:cache/:path{.+}', nixHandler);
nixRoutes.all('/cache/:cache', nixHandler);
