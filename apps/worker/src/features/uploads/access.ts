import type { UploadStateResponse } from '../../types';
import { assertNamespaceId } from '../domain/validation';
import { authFor, getCache } from '../cache/directory';
import { idStub, unwrapRpc } from '../../rpc';

export async function uploadAccess(c: {
  env: Env;
  req: { param(name: string): string; raw: Request };
}) {
  const id = c.req.param('id');
  assertNamespaceId(id, 'upload');
  const job = idStub(c.env.UPLOAD_JOB, id);
  const access = unwrapRpc(await job.access());
  const cache = await getCache(c.env, access.cache);
  await authFor(c.req.raw, c.env, cache, 'push');
  return { id, cache, job };
}

export function stateResponse(value: UploadStateResponse): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } });
}
