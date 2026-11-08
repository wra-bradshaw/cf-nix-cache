import { Hono } from 'hono';
import { DomainError } from '../../shared/errors';
import { idempotency, type AppEnv } from '../../shared/http';
import { unwrapRpc } from '../../shared/rpc';
import { uploadAccess, stateResponse } from './access';
import { completeEncoded } from './encoded';

export const uploadRoutes = new Hono<AppEnv>();

/** What CLIs from before client-encoded uploads call. */
const stagingRemoved = () => {
  throw new DomainError(
    'staging_upload_removed',
    'this server only accepts client-encoded uploads; upgrade cf-nix-cache',
    410,
  );
};
uploadRoutes.post('/api/uploads', stagingRemoved);
uploadRoutes.put('/api/uploads/:id/parts/:number', stagingRemoved);

uploadRoutes.post('/api/uploads/:id/complete', async (c) => {
  const { job, access } = await uploadAccess(c);
  idempotency(c.req.raw);
  if (!access.encoded) return stateResponse(unwrapRpc(await job.state()));
  return stateResponse(await completeEncoded(c.env, job));
});

uploadRoutes.get('/api/uploads/:id/state', async (c) => {
  const { job } = await uploadAccess(c);
  return stateResponse(unwrapRpc(await job.state()));
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
