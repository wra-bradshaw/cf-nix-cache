import { Hono } from 'hono';
import { idempotency, type AppEnv } from '../../shared/http';
import { unwrapRpc } from '../../shared/rpc';
import { uploadAccess, stateResponse } from './access';
import { completeEncoded } from './encoded';

export const uploadRoutes = new Hono<AppEnv>();

uploadRoutes.post('/api/uploads/:id/complete', async (c) => {
  const { job } = await uploadAccess(c);
  idempotency(c.req.raw);
  return stateResponse(await completeEncoded(c.env, job));
});

uploadRoutes.get('/api/uploads/:id', async (c) => {
  const { job } = await uploadAccess(c);
  return stateResponse(unwrapRpc(await job.state()));
});

uploadRoutes.delete('/api/uploads/:id', async (c) => {
  const { job } = await uploadAccess(c);
  idempotency(c.req.raw);
  return stateResponse(unwrapRpc(await job.abort()));
});
