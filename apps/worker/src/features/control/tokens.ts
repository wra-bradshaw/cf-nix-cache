import { Hono } from 'hono';
import { authenticate, authenticateAny } from '../auth/authentication';
import {
  assertOpaqueId,
  BootstrapRequestSchema,
  encodeCursor,
  parseJsonSchema,
  TokenRequestSchema,
} from '../domain/validation';
import type { AuditEvent, PageResponse, TokenSummary } from '../../types';
import { idempotency, parseJson, type AppEnv } from '../runtime/http';
import { issueFromInput } from '../runtime/tokens';
import { namedStub, unwrapRpc } from '../../rpc';
import { auditShardNames } from '../audit/shard';
import { pageLimit } from './helpers';

export const tokenRoutes = new Hono<AppEnv>();

tokenRoutes.post('/api/bootstrap', async (c) => {
  const operationId = idempotency(c.req.raw);
  const input = parseJsonSchema(
    BootstrapRequestSchema,
    await parseJson(c.req.raw),
  );
  const now = Math.floor(Date.now() / 1000);
  const result = unwrapRpc(
    await namedStub(c.env.TOKEN_CATALOG, 'catalog').bootstrap({
      operation_id: operationId,
      fingerprint: JSON.stringify({
        subject: input.subject,
        valid_for_seconds: input.valid_for_seconds,
        grants: input.grants,
      }),
      subject: input.subject,
      grants: input.grants,
      expires_at: now + input.valid_for_seconds,
      secret: input.secret,
    }),
  );
  return c.json(result, result.repeated ? 200 : 201);
});

tokenRoutes.post('/api/tokens', async (c) => {
  const operationId = idempotency(c.req.raw);
  const admin = await authenticateAny(c.req.raw, c.env, 'admin');
  const input = parseJsonSchema(TokenRequestSchema, await parseJson(c.req.raw));
  const result = await issueFromInput(
    c.env,
    input,
    `token:${operationId}`,
    admin,
  );
  return c.json(result, result.repeated ? 200 : 201);
});

tokenRoutes.get('/api/tokens', async (c) => {
  await authenticate(c.req.raw, c.env, '*', 'admin');
  const result = unwrapRpc(
    await namedStub(c.env.TOKEN_CATALOG, 'catalog').list({
      limit: pageLimit(c.req.query('limit')),
      cursor: c.req.query('cursor') ?? null,
    }),
  ) as PageResponse<TokenSummary>;
  return c.json(result);
});

tokenRoutes.delete('/api/tokens/:jti', async (c) => {
  const operationId = idempotency(c.req.raw);
  const admin = await authenticate(c.req.raw, c.env, '*', 'admin');
  const jti = c.req.param('jti');
  assertOpaqueId(jti, 'token');
  unwrapRpc(
    await namedStub(c.env.TOKEN_CATALOG, 'catalog').revoke({
      operation_id: `revoke:${operationId}`,
      jti,
      actor: admin.sub,
    }),
  );
  return c.json({ revoked: true });
});

tokenRoutes.get('/api/audit', async (c) => {
  await authenticate(c.req.raw, c.env, '*', 'admin');
  const limit = pageLimit(c.req.query('limit'));
  const cursor = c.req.query('cursor') ?? null;
  const pages = await Promise.all(
    auditShardNames().map(async (name) =>
      unwrapRpc(await namedStub(c.env.AUDIT_LOG, name).list({ limit, cursor })),
    ),
  );
  const items = pages
    .flatMap((page) => page.items)
    .sort((left, right) =>
      right.timestamp !== left.timestamp
        ? right.timestamp - left.timestamp
        : right.id === left.id
          ? 0
          : right.id > left.id
            ? 1
            : -1,
    );
  const selected = items.slice(0, limit) as AuditEvent[];
  const hasMore =
    items.length > limit || pages.some((page) => page.next_cursor !== null);
  const last = selected.at(-1);
  return c.json({
    items: selected,
    next_cursor:
      hasMore && last
        ? encodeCursor({ timestamp: last.timestamp, id: last.id })
        : null,
  } satisfies PageResponse<AuditEvent>);
});
