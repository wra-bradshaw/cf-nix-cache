import { Hono } from 'hono';
import { assertCacheName, assertStoreHash } from '../../shared/identifiers';
import { MissingPathsSchema, parseJsonSchema } from '../../shared/schemas';
import { idempotency, parseJson, type AppEnv } from '../../shared/http';
import { authFor } from './access';
import { coordinator } from './stubs';
import { getCache, getPath, touchPath } from './resolve-cache';
import { isNotFound, unwrapRpc } from '../../shared/rpc';
import { publicationFor } from './publication-adapters';
import { authenticate } from '../auth/authentication';
import { auditEvent } from '../audit/event';

export const pathRoutes = new Hono<AppEnv>();

pathRoutes.post('/api/caches/:name/missing', async (c) => {
  const name = c.req.param('name');
  assertCacheName(name);
  const cache = await getCache(c.env, name);
  idempotency(c.req.raw);
  await authFor(c.req.raw, c.env, cache, 'push');
  const input = parseJsonSchema(MissingPathsSchema, await parseJson(c.req.raw));
  const missing: string[] = [];
  for (const storeHash of input.store_hashes) {
    try {
      await getPath(c.env, cache, storeHash);
      // A repeated push of a path counts as use, even if nothing downloads it.
      c.executionCtx.waitUntil(touchPath(c.env, cache, storeHash));
    } catch (caught) {
      if (isNotFound(caught)) missing.push(storeHash);
      else throw caught;
    }
  }
  return c.json({ missing });
});

pathRoutes.delete('/api/caches/:name/paths/:storeHash', async (c) => {
  const operationId = idempotency(c.req.raw);
  const name = c.req.param('name');
  assertCacheName(name);
  const cache = await getCache(c.env, name);
  const admin = await authenticate(c.req.raw, c.env, cache.name, 'admin');
  const storeHash = c.req.param('storeHash');
  assertStoreHash(storeHash);
  const prepared = await publicationFor(c.env, cache, storeHash).execute(
    `delete:${cache.reference.incarnation}:${storeHash}:${operationId}`,
    { kind: 'delete', store_hash: storeHash },
  );
  unwrapRpc(
    await coordinator(c.env, cache.reference).recordAudit(
      auditEvent(
        `path-delete:${operationId}`,
        admin.sub,
        'path.delete',
        `${cache.name}/${storeHash}`,
        'success',
      ),
    ),
  );
  return c.json({ deleted: Boolean(prepared.previous) });
});
