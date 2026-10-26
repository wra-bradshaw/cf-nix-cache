import { Hono, type Context } from 'hono';
import { assertCacheName, DomainError } from '../domain/validation';
import type { AppEnv } from '../runtime/http';
import { assertActive, authFor, getCache, getPath } from '../cache/directory';
import { serveNarObject } from './object';

export const nixRoutes = new Hono<AppEnv>();

async function nixHandler(c: Context<AppEnv>): Promise<Response> {
  const request = c.req.raw;
  if (request.method !== 'GET' && request.method !== 'HEAD')
    throw new DomainError('method_not_allowed', 'method not allowed', 405);
  const cacheName = c.req.param('cache') ?? '';
  assertCacheName(cacheName);
  const suffix = c.req.param('path') ?? '';
  const cache = await getCache(c.env, cacheName);
  assertActive(cache);
  const cacheControl = cache.public
    ? 'public, max-age=300'
    : 'private, no-store';
  if (suffix === 'nix-cache-info') {
    await authFor(request, c.env, cache, 'pull');
    return new Response(
      request.method === 'HEAD'
        ? null
        : 'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n',
      {
        headers: {
          'content-type': 'text/plain',
          'cache-control': cacheControl,
        },
      },
    );
  }
  const narInfo = /^([0-9abcdfghijklmnpqrsvwxyz]{32})\.narinfo$/.exec(suffix);
  const narObject = /^nar\/([0-9abcdfghijklmnpqrsvwxyz]{32})\.nar\.zst$/.exec(
    suffix,
  );
  const storeHash = (narInfo ?? narObject)?.[1];
  if (!storeHash) throw new DomainError('not_found', 'path not found', 404);
  await authFor(request, c.env, cache, 'pull');
  // A missing path surfaces as the shard's not_found / "path not found".
  const record = await getPath(c.env, cache, storeHash);
  if (narInfo)
    return new Response(request.method === 'HEAD' ? null : record.narinfo, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        etag: `"${record.file_hash}"`,
        'cache-control': cacheControl,
      },
    });
  return serveNarObject(c, cache, storeHash, record);
}

nixRoutes.all('/cache/:cache/:path{.+}', nixHandler);
nixRoutes.all('/cache/:cache', nixHandler);
