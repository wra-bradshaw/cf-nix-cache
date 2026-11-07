import { Hono } from 'hono';
import { authenticateAny, authenticateGlobal } from './authentication';
import { canDelegate } from './authorization';
import { assertOpaqueId } from '../../shared/identifiers';
import {
  BootstrapRequestSchema,
  parseJsonSchema,
  TokenRequestSchema,
} from '../../shared/schemas';
import { DomainError } from '../../shared/errors';
import type { PageResponse } from '../../shared/cursors';
import type { TokenSummary } from './types';
import {
  idempotency,
  parseJson,
  type AppEnv,
  pageLimit,
} from '../../shared/http';
import { namedStub, unwrapRpc } from '../../shared/rpc';

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
  const expiresAt = Math.floor(Date.now() / 1000) + input.valid_for_seconds;
  if (!canDelegate(admin, input.grants, expiresAt))
    throw new DomainError(
      'forbidden',
      'requested grants must be individually covered by an administrator grant and expire no later than the issuer',
      403,
    );
  const result = unwrapRpc(
    await namedStub(c.env.TOKEN_CATALOG, 'catalog').issue({
      operation_id: `token:${operationId}`,
      fingerprint: JSON.stringify(input),
      actor: admin.sub,
      subject: input.subject,
      grants: input.grants,
      expires_at: expiresAt,
    }),
  );
  return c.json(result, result.repeated ? 200 : 201);
});

tokenRoutes.get('/api/tokens', async (c) => {
  await authenticateGlobal(c.req.raw, c.env, 'admin');
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
  const admin = await authenticateGlobal(c.req.raw, c.env, 'admin');
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
