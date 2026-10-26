import { Hono } from 'hono';
import {
  assertCacheName,
  assertStoreHash,
  MissingPathsSchema,
  parseJsonSchema,
} from '../domain/validation';
import { idempotency, parseJson, type AppEnv } from '../runtime/http';
import {
  authFor,
  coordinator,
  getCache,
  getPath,
  isNotFound,
} from '../cache/directory';
import { unwrapRpc } from '../../rpc';
import { publicationFor } from '../cache/adapters';
import { authenticate } from '../auth/authentication';
import { event } from './helpers';

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
    assertStoreHash(storeHash);
    try {
      await getPath(c.env, cache, storeHash);
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
      event(
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
