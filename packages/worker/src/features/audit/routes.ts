import { Hono } from 'hono';
import { encodeCursor, type PageResponse } from '../../shared/cursors';
import { pageLimit, type AppEnv } from '../../shared/http';
import { namedStub, unwrapRpc } from '../../shared/rpc';
import { authenticateGlobal } from '../auth/authentication';
import { auditShardNames } from './shard';
import type { AuditEvent } from './types';

export const auditRoutes = new Hono<AppEnv>();

auditRoutes.get('/api/audit', async (c) => {
  await authenticateGlobal(c.req.raw, c.env, 'admin');
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
