import { Hono } from 'hono';
import { authenticate, authenticateGlobal } from '../auth/authentication';
import {
  assertCacheName,
  ConfigureCacheSchema,
  CreateCacheSchema,
  decodeCursor,
  encodeCursor,
  parseJsonSchema,
} from '../domain/validation';
import { ensureWorkflow } from '../workflows/workflow';
import { idempotency, parseJson, type AppEnv } from '../runtime/http';
import {
  coordinator,
  effectiveLifecycle,
  getCache,
  publicCache,
  system,
} from '../cache/directory';
import { unwrapRpc } from '../../rpc';
import { ENCODING_ID } from '../../types';
import { event } from './helpers';
import { pageLimit } from './helpers';

export const cacheRoutes = new Hono<AppEnv>();

cacheRoutes.post('/api/caches', async (c) => {
  const operationId = idempotency(c.req.raw);
  const admin = await authenticateGlobal(c.req.raw, c.env, 'admin');
  const input = parseJsonSchema(CreateCacheSchema, await parseJson(c.req.raw));
  const creation = unwrapRpc(
    await system(c.env).createCache({
      operation_id: operationId,
      fingerprint: JSON.stringify(input),
      name: input.name,
      public: input.public ?? false,
      quota_bytes: input.quota_bytes,
      encoding_id: input.encoding_id ?? ENCODING_ID,
    }),
  );
  const reference = creation.reference;
  const cacheCoordinator = coordinator(c.env, reference);
  unwrapRpc(
    await cacheCoordinator.initialize({
      reference,
      public: input.public ?? false,
      quota_bytes: input.quota_bytes,
      encoding_id: input.encoding_id ?? ENCODING_ID,
      created_at: Math.floor(Date.now() / 1000),
    }),
  );
  // Activate the serving authority first. The catalogue remains CREATING
  // until this succeeds, so a lost response leaves a state that a later
  // create request can safely resume.
  const active = unwrapRpc(await cacheCoordinator.activate());
  unwrapRpc(await system(c.env).activateCache(reference));
  unwrapRpc(
    await cacheCoordinator.recordAudit(
      event(
        `cache-create:${operationId}`,
        admin.sub,
        'cache.create',
        input.name,
        'success',
      ),
    ),
  );
  return c.json(
    publicCache({ ...active, reference }),
    creation.repeated ? 200 : 201,
  );
});

cacheRoutes.get('/api/caches', async (c) => {
  await authenticate(c.req.raw, c.env, '*', 'admin');
  const limit = pageLimit(c.req.query('limit'));
  const after = decodeCursor<string>(c.req.query('cursor') ?? null) ?? null;
  const page = unwrapRpc(await system(c.env).listCaches({ after, limit }));
  const items = await Promise.all(
    page.items.map(async (reference) => {
      const config = unwrapRpc(await coordinator(c.env, reference).getCache());
      return publicCache({
        ...config,
        lifecycle: effectiveLifecycle(reference.lifecycle, config.lifecycle),
        reference,
      });
    }),
  );
  return c.json({
    items,
    next_cursor: page.next_after ? encodeCursor(page.next_after) : null,
  });
});

cacheRoutes.get('/api/caches/:name', async (c) => {
  const name = c.req.param('name');
  assertCacheName(name);
  const cache = await getCache(c.env, name);
  await authenticate(c.req.raw, c.env, '*', 'admin');
  return c.json(publicCache(cache));
});

cacheRoutes.delete('/api/caches/:name', async (c) => {
  const operationId = idempotency(c.req.raw);
  const name = c.req.param('name');
  assertCacheName(name);
  const cache = await getCache(c.env, name);
  const admin = await authenticate(c.req.raw, c.env, cache.name, 'admin');
  const deletion = unwrapRpc(
    await system(c.env).beginDelete({
      reference: cache.reference,
      operation_id: operationId,
    }),
  );
  unwrapRpc(await coordinator(c.env, cache.reference).beginDelete());
  unwrapRpc(
    await coordinator(c.env, cache.reference).recordAudit(
      event(
        `cache-delete:${operationId}`,
        admin.sub,
        'cache.delete',
        cache.name,
        'accepted',
      ),
    ),
  );
  await ensureWorkflow(
    c.env.DELETE_CACHE!,
    `delete:${cache.reference.incarnation}`,
    {
      cache: cache.name,
      cache_id: cache.reference.id,
      incarnation: cache.reference.incarnation,
      coordinator_id: cache.reference.coordinator_id,
      operation_id: deletion.operation_id,
    },
  );
  return c.json({ deleting: true }, 202);
});

cacheRoutes.patch('/api/caches/:name/config', async (c) => {
  const operationId = idempotency(c.req.raw);
  const name = c.req.param('name');
  assertCacheName(name);
  const cache = await getCache(c.env, name);
  const admin = await authenticate(c.req.raw, c.env, cache.name, 'admin');
  const input = parseJsonSchema(
    ConfigureCacheSchema,
    await parseJson(c.req.raw),
  );
  const updated = unwrapRpc(
    await coordinator(c.env, cache.reference).configure(input),
  );
  unwrapRpc(
    await coordinator(c.env, cache.reference).recordAudit(
      event(
        `cache-config:${operationId}`,
        admin.sub,
        'cache.configure',
        cache.name,
        'success',
      ),
    ),
  );
  return c.json(updated);
});
