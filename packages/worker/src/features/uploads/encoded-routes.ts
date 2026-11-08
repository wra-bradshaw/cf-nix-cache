import { Hono } from 'hono';
import { DomainError } from '../../shared/errors';
import {
  idempotency,
  parseContentLength,
  parseJson,
  type AppEnv,
} from '../../shared/http';
import {
  EncodedCompleteBatchSchema,
  EncodedUploadBatchSchema,
  EncodedUploadRequestSchema,
  parseJsonSchema,
} from '../../shared/schemas';
import { authFor } from '../cache/access';
import { getCache } from '../cache/resolve-cache';
import { CHUNK_MAX_COMPRESSED_SIZE } from './encoding';
import { completeEncoded, openEncoded, storeChunk } from './encoded';
import { uploadAccess } from './access';
import { unwrapRpc } from '../../shared/rpc';
import { mapLimit } from '../../shared/concurrency';

export const encodedUploadRoutes = new Hono<AppEnv>();

export const NAR_HASH = /^sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}$/;
const BATCH_CONCURRENCY = 16;
const MAX_BATCH_BODY = 64 * 1024 * 1024;

encodedUploadRoutes.post('/api/uploads/encoded', async (c) => {
  const key = idempotency(c.req.raw);
  const input = parseJsonSchema(
    EncodedUploadRequestSchema,
    await parseJson(c.req.raw),
  );
  const cache = await getCache(c.env, input.manifest.cache);
  await authFor(c.req.raw, c.env, cache, 'push');
  const result = await openEncoded(c.env, cache, key, input);
  return c.json(result, result.merged ? 200 : 201);
});

encodedUploadRoutes.post('/api/uploads/encoded/batch', async (c) => {
  const key = idempotency(c.req.raw);
  const input = parseJsonSchema(
    EncodedUploadBatchSchema,
    await parseJson(c.req.raw),
  );
  const name = input.uploads[0]!.manifest.cache;
  if (input.uploads.some((upload) => upload.manifest.cache !== name))
    throw new DomainError(
      'validation_failed',
      'a batch must target one cache',
      422,
    );
  const cache = await getCache(c.env, name);
  await authFor(c.req.raw, c.env, cache, 'push');
  const uploads = await mapLimit(input.uploads, BATCH_CONCURRENCY, (upload) =>
    openEncoded(c.env, cache, `${key}:${upload.manifest.store_hash}`, upload),
  );
  return c.json({ uploads });
});

encodedUploadRoutes.put('/api/uploads/:id/chunks/:hash', async (c) => {
  const { job } = await uploadAccess(c);
  idempotency(c.req.raw);
  const hash = c.req.param('hash');
  if (!NAR_HASH.test(hash))
    throw new DomainError('validation_failed', 'invalid chunk hash', 422);
  const length = parseContentLength(c.req.raw);
  if (length > CHUNK_MAX_COMPRESSED_SIZE)
    throw new DomainError('payload_too_large', 'chunk is too large', 413);
  const body = new Uint8Array(await c.req.raw.arrayBuffer());
  if (body.byteLength > CHUNK_MAX_COMPRESSED_SIZE)
    throw new DomainError('payload_too_large', 'chunk is too large', 413);
  if (body.byteLength !== length)
    throw new DomainError(
      'validation_failed',
      'chunk body size does not match Content-Length',
      400,
    );
  await storeChunk(c.env, job, hash, body);
  return new Response(null, {
    status: 204,
    headers: { 'cache-control': 'no-store' },
  });
});

encodedUploadRoutes.post('/api/uploads/encoded/batch/complete', async (c) => {
  idempotency(c.req.raw);
  const length = Number(c.req.header('content-length') ?? NaN);
  if (!Number.isSafeInteger(length) || length > MAX_BATCH_BODY)
    throw new DomainError(
      'payload_too_large',
      'batch body is too large or has no length',
      413,
    );
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    throw new DomainError(
      'validation_failed',
      'body must be multipart/form-data',
      400,
    );
  }
  const requestField = form.get('request');
  if (requestField === null)
    throw new DomainError(
      'validation_failed',
      'batch is missing request field',
      400,
    );
  let request: unknown;
  try {
    request = JSON.parse(
      typeof requestField === 'string'
        ? requestField
        : await requestField.text(),
    );
  } catch {
    throw new DomainError(
      'validation_failed',
      'request field is not JSON',
      400,
    );
  }
  const { ids } = parseJsonSchema(EncodedCompleteBatchSchema, request);
  const uploads = await mapLimit(ids, BATCH_CONCURRENCY, async (id) => {
    const { job } = await uploadAccess({
      env: c.env,
      req: { param: () => id, raw: c.req.raw },
    });
    const missing = unwrapRpc(await job.missingChunks());
    for (const hash of missing) {
      const value = form.get(hash);
      if (value === null || typeof value === 'string')
        throw new DomainError(
          'invalid_input',
          `batch is missing chunk ${hash}`,
          400,
        );
      const valueBytes = new Uint8Array(await value.arrayBuffer());
      if (valueBytes.byteLength > CHUNK_MAX_COMPRESSED_SIZE)
        throw new DomainError('payload_too_large', 'chunk is too large', 413);
      await storeChunk(c.env, job, hash, valueBytes);
    }
    return completeEncoded(c.env, job);
  });
  return c.json({ uploads }, 200, { 'cache-control': 'no-store' });
});
