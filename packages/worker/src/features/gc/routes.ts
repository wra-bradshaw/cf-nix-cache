import { Hono } from 'hono';
import { authenticateGlobal } from '../auth/authentication';
import { GcRunRequestSchema, parseJsonSchema } from '../../shared/schemas';
import { gcControl } from './gc-adapters';
import { idempotency, parseJson, type AppEnv } from '../../shared/http';
import { ensureWorkflow } from '../../shared/workflows';
import { unwrapRpc } from '../../shared/rpc';
import { auditEvent } from '../audit/event';

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
      auditEvent(`gc-run:${runId}`, admin.sub, 'gc.run', runId, 'accepted'),
    ),
  );
  await ensureWorkflow(c.env.GARBAGE_COLLECT!, runId, input);
  return c.json({ run_id: runId }, 202);
});

gcRoutes.get('/api/gc', async (c) => {
  await authenticateGlobal(c.req.raw, c.env, 'admin');
  return c.json(unwrapRpc(await gcControl(c.env).status()));
});
