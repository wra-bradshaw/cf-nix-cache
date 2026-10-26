import { Hono } from 'hono';
import {
  CompleteUploadSchema,
  parseJsonSchema,
  partsFor,
  requestFingerprint,
  parseContentLength,
  UploadRequestSchema,
  validateUploadManifest,
} from '../domain/validation';
import type { InitiateUploadResponse } from '../../types';
import { MULTIPART_PART_SIZE } from '../../types';
import { idempotency, parseJson, type AppEnv } from '../runtime/http';
import { authFor, coordinator, getCache } from '../cache/directory';
import { idStub, unwrapRpc } from '../../rpc';
import { uploadAccess, stateResponse } from './access';

export const uploadRoutes = new Hono<AppEnv>();

uploadRoutes.post('/api/uploads', async (c) => {
  const key = idempotency(c.req.raw);
  const input = parseJsonSchema(
    UploadRequestSchema,
    await parseJson(c.req.raw),
  );
  validateUploadManifest(input.manifest);
  const cache = await getCache(c.env, input.manifest.cache);
  await authFor(c.req.raw, c.env, cache, 'push');
  const fingerprint = requestFingerprint(input);
  const allocation = unwrapRpc(
    await coordinator(c.env, cache.reference).allocateUpload({
      operation_id: key,
      fingerprint,
    }),
  );
  const job = idStub(c.env.UPLOAD_JOB, allocation.id);
  const state = unwrapRpc(
    await job.init({
      job_id: allocation.id,
      cache: cache.name,
      cache_id: cache.reference.id,
      incarnation: cache.reference.incarnation,
      staging_key: allocation.staging_key,
      manifest: input.manifest,
      compressed_size: input.compressed_size,
      idempotency_key: key,
      fingerprint,
    }),
  );
  const parts = partsFor(input.compressed_size, MULTIPART_PART_SIZE);
  const result: InitiateUploadResponse = {
    id: allocation.id,
    status: state.state,
    error: null,
    parts: Array.from({ length: parts }, (_, index) => ({
      part_number: index + 1,
      url: `${new URL(c.req.url).origin}/api/uploads/${allocation.id}/parts/${index + 1}`,
    })),
  };
  return c.json(result, allocation.repeated ? 200 : 201);
});

uploadRoutes.put('/api/uploads/:id/parts/:number', async (c) => {
  const { job } = await uploadAccess(c);
  idempotency(c.req.raw);
  const number = Number(c.req.param('number'));
  const result = unwrapRpc(
    await job.putPart({
      number,
      length: parseContentLength(c.req.raw),
      body: c.req.raw.body,
    }),
  );
  return new Response(null, {
    status: 200,
    headers: { etag: result.etag, 'cache-control': 'no-store' },
  });
});

uploadRoutes.post('/api/uploads/:id/complete', async (c) => {
  const { job } = await uploadAccess(c);
  idempotency(c.req.raw);
  const input = parseJsonSchema(
    CompleteUploadSchema,
    await parseJson(c.req.raw),
  );
  return stateResponse(unwrapRpc(await job.complete(input)));
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
