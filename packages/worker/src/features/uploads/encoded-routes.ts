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

/**
 * Chunk-hash shape. Canonical copy lives as `RAW_HASH` in `verifier.ts`;
 * this copy is kept (rather than imported) so the routes module avoids
 * pulling in the verifier's wasm import. The two must stay in sync and are
 * pinned equal in `verifier.test.ts` ("pins the chunk-hash shape shared with
 * the upload routes", which asserts both copies share one source and pins
 * the literal shape, so local `pnpm test` already covers this duplicate
 * with no manual drift step) — a change to the accepted hash shape must
 * update both. A single shared home such as `shared/identifiers.ts` would
 * remove the duplicate; kept as two copies because `verifier.ts` cannot move
 * without taking its wasm import along (see its `RAW_HASH` comment).
 */
export const NAR_HASH = /^sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}$/;
/** Paths opened or completed together, run this many at a time. */
const BATCH_CONCURRENCY = 16;
/** A batch's chunk bodies; the request limit is 100 MB. */
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

/**
 * Opens up to 64 uploads to one cache in a single request. Not atomic:
 * `mapLimit` rejects the whole batch on the first failure, while uploads
 * that already opened stay open (their leases and rows remain). No
 * compensating abort is issued — leases expire on their own — so callers must
 * treat a batch error as partial success and query each upload individually
 * rather than assuming none opened.
 */
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
  // Post-read: the header is untrusted, so enforce the cap on the bytes
  // actually buffered (a lying Content-Length must not admit an oversize
  // body) and reject a body whose size disagrees with its header.
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

/**
 * Uploads the chunks of several opened uploads and completes them. The body is
 * multipart/form-data: a `request` field holding `{ids}`, and one file field
 * per chunk, named by its raw hash. Not atomic: `mapLimit` rejects the whole
 * batch on the first failure, while uploads that already completed stay
 * completed. No compensating abort is issued, so callers must treat a batch
 * error as partial success and query each upload individually rather than
 * assuming none completed.
 */
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
  // A missing field is a malformed batch, not bad JSON: `form.get` returns
  // null when the field is absent, and calling `.text()` on it would throw a
  // TypeError that the catch below would misreport as "not JSON".
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
      // A missing field is a malformed batch, not an upload still waiting
      // for chunks: skipping it here would surface later as a generic
      // `chunks_missing` from completion instead of naming the field.
      if (value === null || typeof value === 'string')
        throw new DomainError(
          'invalid_input',
          `batch is missing chunk ${hash}`,
          400,
        );
      // Post-read: multipart fields have no per-file header to pre-check,
      // so enforce the chunk cap on the bytes actually buffered.
      const valueBytes = new Uint8Array(await value.arrayBuffer());
      if (valueBytes.byteLength > CHUNK_MAX_COMPRESSED_SIZE)
        throw new DomainError('payload_too_large', 'chunk is too large', 413);
      await storeChunk(c.env, job, hash, valueBytes);
    }
    return completeEncoded(c.env, job);
  });
  return c.json({ uploads }, 200, { 'cache-control': 'no-store' });
});
