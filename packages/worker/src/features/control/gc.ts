import { Hono } from 'hono';
import { authenticateGlobal } from '../auth/authentication';
import { GcRunRequestSchema, parseJsonSchema } from '../domain/validation';
import { gcControl } from '../gc/adapters';
import { idempotency, parseJson, type AppEnv } from '../runtime/http';
import { ensureWorkflow } from '../workflows/enqueue';
import { unwrapRpc } from '../../rpc';
import { event } from './helpers';

export const gcRoutes = new Hono<AppEnv>();

/** Workflow instance IDs allow fewer characters than idempotency keys. */
async function runIdFor(operationId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(operationId),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `manual-${hex.slice(0, 32)}`;
}

gcRoutes.post('/api/gc', async (c) => {
  const operationId = idempotency(c.req.raw);
  const admin = await authenticateGlobal(c.req.raw, c.env, 'admin');
  const input = parseJsonSchema(GcRunRequestSchema, await parseJson(c.req.raw));
  const runId = await runIdFor(operationId);
  unwrapRpc(
    await gcControl(c.env).recordAudit(
      event(`gc-run:${runId}`, admin.sub, 'gc.run', runId, 'accepted'),
    ),
  );
  await ensureWorkflow(c.env.GARBAGE_COLLECT!, runId, input);
  return c.json({ run_id: runId }, 202);
});

gcRoutes.get('/api/gc', async (c) => {
  await authenticateGlobal(c.req.raw, c.env, 'admin');
  return c.json(unwrapRpc(await gcControl(c.env).status()));
});
