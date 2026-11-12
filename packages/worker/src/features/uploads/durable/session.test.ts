import { constants, zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import type { EncodedUploadRequest } from '../../../generated/contracts';
import { getCache } from '../../cache/resolve-cache';
import { unwrapRpc } from '../../../shared/rpc';
import { openEncoded, storeChunk } from '../encoded';
import { chunkKey, sha256Nix, type ChunkClaim } from '../encoding';
import { chunkList, verifyStoredNar, storeManifest } from '../verify-stored';
import { narOfFile } from '../test-helpers';
import type { CacheCoordinator } from '../../cache/durable/coordinator';
import type { UploadJob } from './job';
import { INLINE_VERIFY_STALL_MS } from './session';

const encoder = new TextEncoder();

async function setupCache(name: string, tag: string) {
  const system = env.SYSTEM_CONTROL.getByName('system');
  const created = await system.createCache({
    operation_id: `op-${tag}`,
    fingerprint: `fp-${tag}`,
    name,
    public: true,
    quota_bytes: 1_000_000_000,
    encoding_id: 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1',
  });
  if (!created.ok) throw new Error('create: ' + JSON.stringify(created.error));
  const reference = created.value.reference;
  const coordinator = env.CACHE_COORDINATOR.get(
    env.CACHE_COORDINATOR.idFromString(reference.coordinator_id),
  );
  const initialized = await coordinator.initialize({
    reference,
    public: true,
    quota_bytes: 1_000_000_000,
    encoding_id: 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1',
    created_at: 1,
    upstream_cache_key_names: [],
  });
  if (!initialized.ok)
    throw new Error('init: ' + JSON.stringify(initialized.error));
  const activated = await coordinator.activate();
  if (!activated.ok)
    throw new Error('activate: ' + JSON.stringify(activated.error));
  const catalogued = await system.activateCache(reference);
  if (!catalogued.ok)
    throw new Error('catalogue: ' + JSON.stringify(catalogued.error));
  return { reference, coordinator };
}

async function openUpload(
  cache: string,
  reference: { id: string; incarnation: string },
  coordinator: DurableObjectStub<CacheCoordinator>,
  tag: string,
) {
  const nar = narOfFile(encoder.encode(`hello ${tag}`));
  const compressed = new Uint8Array(zstdCompressSync(nar));
  const rawHash = await sha256Nix(nar);
  const compressedHash = await sha256Nix(compressed);
  const manifest = {
    cache,
    store_hash: '0'.repeat(32),
    store_path: `/nix/store/${'0'.repeat(32)}-hello`,
    nar_hash: rawHash,
    nar_size: nar.length,
    references: [],
    deriver: null,
    ca: null,
  };
  const allocation = await coordinator.allocateUpload({
    operation_id: `op-upload-${tag}`,
    fingerprint: `fpupload-${tag}`,
    store_hash: manifest.store_hash,
    nar_hash: manifest.nar_hash,
    now: 2,
    merge: false,
  });
  if (!allocation.ok)
    throw new Error('allocate: ' + JSON.stringify(allocation.error));
  const jobId = allocation.value.id;
  const job = env.UPLOAD_JOB.get(env.UPLOAD_JOB.idFromString(jobId));
  const opened = await job.openSession({
    job_id: jobId,
    cache,
    cache_id: reference.id,
    incarnation: reference.incarnation,
    chunks_key: allocation.value.chunks_key,
    manifest,
    compressed_size: compressed.length,
    idempotency_key: `idem-${tag}`,
    fingerprint: `fp-${tag}`,
    chunks: [
      {
        raw_hash: rawHash,
        raw_size: nar.length,
        compressed_hash: compressedHash,
        compressed_size: compressed.length,
      },
    ],
  });
  if (!opened.ok) throw new Error('open: ' + JSON.stringify(opened.error));
  return { nar, compressed, rawHash, jobId, job };
}

describe('upload session flow through real DOs', () => {
  it('opens, completes and publishes a tiny upload', async () => {
    const system = env.SYSTEM_CONTROL.getByName('system');
    const created = await system.createCache({
      operation_id: 'op1',
      fingerprint: 'fp1',
      name: 'flow',
      public: true,
      quota_bytes: 1_000_000_000,
      encoding_id: 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1',
    });
    if (!created.ok)
      throw new Error('create: ' + JSON.stringify(created.error));
    const reference = created.value.reference;
    const coordinator = env.CACHE_COORDINATOR.get(
      env.CACHE_COORDINATOR.idFromString(reference.coordinator_id),
    );
    const initialized = await coordinator.initialize({
      reference,
      public: true,
      quota_bytes: 1_000_000_000,
      encoding_id: 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1',
      created_at: 1,
      upstream_cache_key_names: [],
    });
    if (!initialized.ok)
      throw new Error('init: ' + JSON.stringify(initialized.error));
    const activated = await coordinator.activate();
    if (!activated.ok)
      throw new Error('activate: ' + JSON.stringify(activated.error));
    const catalogued = await system.activateCache(reference);
    if (!catalogued.ok)
      throw new Error('catalogue: ' + JSON.stringify(catalogued.error));

    const nar = narOfFile(encoder.encode('hello flow'));
    const compressed = new Uint8Array(zstdCompressSync(nar));
    const rawHash = await sha256Nix(nar);
    const compressedHash = await sha256Nix(compressed);
    const manifest = {
      cache: 'flow',
      store_hash: '0'.repeat(32),
      store_path: `/nix/store/${'0'.repeat(32)}-hello`,
      nar_hash: rawHash,
      nar_size: nar.length,
      references: [],
      deriver: null,
      ca: null,
    };
    const allocation = await coordinator.allocateUpload({
      operation_id: 'op-upload',
      fingerprint: 'fpupload',
      store_hash: manifest.store_hash,
      nar_hash: manifest.nar_hash,
      now: 2,
      merge: false,
    });
    if (!allocation.ok)
      throw new Error('allocate: ' + JSON.stringify(allocation.error));
    const jobId = allocation.value.id;
    const job = env.UPLOAD_JOB.get(env.UPLOAD_JOB.idFromString(jobId));
    const opened = await job.openSession({
      job_id: jobId,
      cache: 'flow',
      cache_id: reference.id,
      incarnation: reference.incarnation,
      chunks_key: allocation.value.chunks_key,
      manifest,
      compressed_size: compressed.length,
      idempotency_key: 'idem1',
      fingerprint: 'fp1',
      chunks: [
        {
          raw_hash: rawHash,
          raw_size: nar.length,
          compressed_hash: compressedHash,
          compressed_size: compressed.length,
        },
      ],
    });
    if (!opened.ok) throw new Error('open: ' + JSON.stringify(opened.error));
    expect(opened.value.missing_chunks).toEqual([rawHash]);

    await env.CACHE_BUCKET.put(chunkKey(rawHash), compressed);
    expect((await job.chunkStored(rawHash)).ok).toBe(true);

    const plan = await job.beginComplete();
    if (!plan.ok || plan.value.kind !== 'inline')
      throw new Error('plan: ' + JSON.stringify(plan));
    const verified = await verifyStoredNar(env.CACHE_BUCKET, plan.value.nar);
    const { result } = await storeManifest(env.CACHE_BUCKET, verified);
    const published = await job.publishVerified(result, verified);
    if (!published.ok)
      throw new Error('publish: ' + JSON.stringify(published.error));
    expect(published.value.status).toBe('READY');

    const state = await job.state();
    if (!state.ok) throw new Error('state: ' + JSON.stringify(state.error));
    expect(state.value.status).toBe('READY');
    expect(state.value.error).toBeNull();
  }, 60000);

  it('accepts repeated chunks and publishes with one stored copy', async () => {
    const { reference, coordinator } = await setupCache(
      'flow-repeat',
      'repeat1',
    );
    const nar = narOfFile(encoder.encode('h'.repeat(6000)));
    const raws: Uint8Array[] = [];
    let offset = 0;
    for (const end of [500, 1500, 2500, nar.length]) {
      raws.push(nar.slice(offset, end));
      offset = end;
    }
    const chunks = await Promise.all(
      raws.map(async (raw) => {
        const compressed = new Uint8Array(zstdCompressSync(raw));
        return {
          claim: {
            raw_hash: await sha256Nix(raw),
            raw_size: raw.length,
            compressed_hash: await sha256Nix(compressed),
            compressed_size: compressed.length,
          },
          compressed,
        };
      }),
    );
    expect(chunks[1]!.claim.raw_hash).toBe(chunks[2]!.claim.raw_hash);
    const rawHash = await sha256Nix(nar);
    const manifest = {
      cache: 'flow-repeat',
      store_hash: '1'.repeat(32),
      store_path: `/nix/store/${'1'.repeat(32)}-hello`,
      nar_hash: rawHash,
      nar_size: nar.length,
      references: [],
      deriver: null,
      ca: null,
    };
    const allocation = await coordinator.allocateUpload({
      operation_id: 'op-upload-repeat1',
      fingerprint: 'fpupload-repeat1',
      store_hash: manifest.store_hash,
      nar_hash: manifest.nar_hash,
      now: 2,
      merge: false,
    });
    if (!allocation.ok)
      throw new Error('allocate: ' + JSON.stringify(allocation.error));
    const jobId = allocation.value.id;
    const job = env.UPLOAD_JOB.get(env.UPLOAD_JOB.idFromString(jobId));
    const opened = await job.openSession({
      job_id: jobId,
      cache: 'flow-repeat',
      cache_id: reference.id,
      incarnation: reference.incarnation,
      chunks_key: allocation.value.chunks_key,
      manifest,
      compressed_size: chunks.reduce(
        (sum, chunk) => sum + chunk.claim.compressed_size,
        0,
      ),
      idempotency_key: 'idem-repeat1',
      fingerprint: 'fp-repeat1',
      chunks: chunks.map((chunk) => chunk.claim),
    });
    if (!opened.ok) throw new Error('open: ' + JSON.stringify(opened.error));
    const unique = [...new Map(chunks.map((c) => [c.claim.raw_hash, c]))];
    expect(opened.value.missing_chunks).toEqual(
      unique.map(([hash]) => hash).sort(),
    );
    for (const [, chunk] of unique) {
      await env.CACHE_BUCKET.put(
        chunkKey(chunk.claim.raw_hash),
        chunk.compressed,
      );
      expect((await job.chunkStored(chunk.claim.raw_hash)).ok).toBe(true);
    }
    const plan = await job.beginComplete();
    if (!plan.ok || plan.value.kind !== 'inline')
      throw new Error('plan: ' + JSON.stringify(plan));
    expect(plan.value.nar.chunks.map((chunk) => chunk.raw_hash)).toEqual(
      chunks.map((chunk) => chunk.claim.raw_hash),
    );
    const verified = await verifyStoredNar(env.CACHE_BUCKET, plan.value.nar);
    expect(verified.nar_hash).toBe(rawHash);
    const { result } = await storeManifest(env.CACHE_BUCKET, verified);
    const published = await job.publishVerified(result, verified);
    if (!published.ok)
      throw new Error('publish: ' + JSON.stringify(published.error));
    expect(published.value.status).toBe('READY');
  }, 60000);

  it('rejects conflicting declarations for the same chunk', async () => {
    const { reference, coordinator } = await setupCache(
      'flow-conflict',
      'conflict1',
    );
    const { nar, compressed, rawHash } = await openUpload(
      'flow-conflict',
      reference,
      coordinator,
      'conflict1',
    );
    void nar;
    void compressed;
    const allocation = await coordinator.allocateUpload({
      operation_id: 'op-upload-conflict1',
      fingerprint: 'fpupload-conflict1',
      store_hash: '2'.repeat(32),
      nar_hash: rawHash,
      now: 2,
      merge: false,
    });
    if (!allocation.ok)
      throw new Error('allocate: ' + JSON.stringify(allocation.error));
    const jobId = allocation.value.id;
    const job = env.UPLOAD_JOB.get(env.UPLOAD_JOB.idFromString(jobId));
    const claim = {
      raw_hash: rawHash,
      raw_size: nar.length,
      compressed_hash: await sha256Nix(compressed),
      compressed_size: compressed.length,
    };
    const opened = await job.openSession({
      job_id: jobId,
      cache: 'flow-conflict',
      cache_id: reference.id,
      incarnation: reference.incarnation,
      chunks_key: allocation.value.chunks_key,
      manifest: {
        cache: 'flow-conflict',
        store_hash: '2'.repeat(32),
        store_path: `/nix/store/${'2'.repeat(32)}-hello`,
        nar_hash: rawHash,
        nar_size: nar.length * 2,
        references: [],
        deriver: null,
        ca: null,
      },
      compressed_size: compressed.length * 2,
      idempotency_key: 'idem-conflict1',
      fingerprint: 'fp-conflict1',
      chunks: [claim, { ...claim, raw_size: claim.raw_size + 1 }],
    });
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error('expected conflicting chunks failure');
    expect(opened.error.message).toMatch('conflicting');
  }, 60000);

  it('rejects chunks that are not part of the upload', async () => {
    const { reference, coordinator } = await setupCache(
      'flow-unknown',
      'unknown1',
    );
    const { job, rawHash } = await openUpload(
      'flow-unknown',
      reference,
      coordinator,
      'unknown1',
    );
    const unknown = await job.chunkStored(
      'sha256:0000000000000000000000000000000000000000000000000000',
    );
    expect(unknown.ok).toBe(false);
    if (unknown.ok) throw new Error('expected unknown_chunk failure');
    expect(unknown.error.code).toBe('unknown_chunk');
    await env.CACHE_BUCKET.put(
      chunkKey(rawHash),
      new Uint8Array(
        zstdCompressSync(narOfFile(encoder.encode('hello unknown1'))),
      ),
    );
    expect((await job.chunkStored(rawHash)).ok).toBe(true);
  }, 60000);

  it('rejects chunkStored after abort and reports ABORTED', async () => {
    const { reference, coordinator } = await setupCache('flow-abort', 'abort1');
    const { job, rawHash } = await openUpload(
      'flow-abort',
      reference,
      coordinator,
      'abort1',
    );
    const aborted = await job.abort();
    if (!aborted.ok) throw new Error('abort: ' + JSON.stringify(aborted));
    expect(aborted.value.status).toBe('ABORTED');
    const stored = await job.chunkStored(rawHash);
    expect(stored.ok).toBe(false);
    if (stored.ok) throw new Error('expected terminal rejection');
    expect(stored.error.status).toBe(409);
  }, 60000);

  it('marks the upload FAILED on reject', async () => {
    const { reference, coordinator } = await setupCache(
      'flow-reject',
      'reject1',
    );
    const { job } = await openUpload(
      'flow-reject',
      reference,
      coordinator,
      'reject1',
    );
    const rejected = await job.reject('bad chunk');
    if (!rejected.ok) throw new Error('reject: ' + JSON.stringify(rejected));
    expect(rejected.value.status).toBe('FAILED');
    expect(rejected.value.error).toContain('bad chunk');
  }, 60000);
});

type JobStub = DurableObjectStub<UploadJob>;

async function openChunked(
  cache: string,
  reference: { id: string; incarnation: string },
  coordinator: DurableObjectStub<CacheCoordinator>,
  tag: string,
  parts: number,
) {
  const nar = narOfFile(encoder.encode(`hello ${tag}`));
  const size = Math.ceil(nar.length / parts);
  const claims: ChunkClaim[] = [];
  const compressed = new Map<string, Uint8Array>();
  for (let offset = 0; offset < nar.length; offset += size) {
    const raw = nar.slice(offset, offset + size);
    const zstd = new Uint8Array(zstdCompressSync(raw));
    const claim = {
      raw_hash: await sha256Nix(raw),
      raw_size: raw.length,
      compressed_hash: await sha256Nix(zstd),
      compressed_size: zstd.length,
    };
    claims.push(claim);
    compressed.set(claim.raw_hash, zstd);
  }
  const manifest = {
    cache,
    store_hash: '3'.repeat(32),
    store_path: `/nix/store/${'3'.repeat(32)}-hello`,
    nar_hash: await sha256Nix(nar),
    nar_size: nar.length,
    references: [],
    deriver: null,
    ca: null,
  };
  const allocation = await coordinator.allocateUpload({
    operation_id: `op-chunked-${tag}`,
    fingerprint: `fpupload-${tag}`,
    store_hash: manifest.store_hash,
    nar_hash: manifest.nar_hash,
    now: 2,
    merge: false,
  });
  if (!allocation.ok)
    throw new Error('allocate: ' + JSON.stringify(allocation.error));
  const jobId = allocation.value.id;
  const job = env.UPLOAD_JOB.get(env.UPLOAD_JOB.idFromString(jobId));
  const opened = await job.openSession({
    job_id: jobId,
    cache,
    cache_id: reference.id,
    incarnation: reference.incarnation,
    chunks_key: allocation.value.chunks_key,
    manifest,
    compressed_size: [...compressed.values()].reduce(
      (sum, bytes) => sum + bytes.length,
      0,
    ),
    idempotency_key: `idem-${tag}`,
    fingerprint: `fp-${tag}`,
    chunks: claims,
  });
  if (!opened.ok) throw new Error('open: ' + JSON.stringify(opened.error));
  return { claims, compressed, job };
}

async function storeClaim(
  job: JobStub,
  claim: ChunkClaim,
  compressed: Map<string, Uint8Array>,
) {
  await storeChunk(env, job, claim.raw_hash, compressed.get(claim.raw_hash)!);
}

describe('joining an in-flight upload', () => {
  it('gives a byte-identical encoder the chunks that are still missing', async () => {
    const cache = 'flow-join';
    const { reference, coordinator } = await setupCache(cache, 'join1');
    const { claims, compressed, job } = await openChunked(
      cache,
      reference,
      coordinator,
      'join1',
      3,
    );
    await storeClaim(job, claims[0]!, compressed);
    await storeClaim(job, claims[2]!, compressed);

    const joined = await job.join(claims);
    if (!joined.ok) throw new Error('join: ' + JSON.stringify(joined.error));
    expect(joined.value).toEqual({
      kind: 'joined',
      missing_chunks: [claims[1]!.raw_hash],
    });
  }, 60000);

  it('refuses a chunk list that differs from the session', async () => {
    const cache = 'flow-join-incompatible';
    const { reference, coordinator } = await setupCache(
      cache,
      'join-incompatible1',
    );
    const { claims, job } = await openChunked(
      cache,
      reference,
      coordinator,
      'join-incompatible1',
      3,
    );
    const retimed = claims.map((claim, index) =>
      index === 1
        ? { ...claim, compressed_hash: claims[0]!.compressed_hash }
        : claim,
    );
    expect(unwrapRpc(await job.join(retimed))).toEqual({
      kind: 'incompatible',
    });
    expect(unwrapRpc(await job.join(claims.slice(0, 2)))).toEqual({
      kind: 'incompatible',
    });
  }, 60000);

  it('reports the state once the upload is no longer accepting chunks', async () => {
    const cache = 'flow-join-state';
    const { reference, coordinator } = await setupCache(cache, 'join-state1');
    const { claims, compressed, job } = await openChunked(
      cache,
      reference,
      coordinator,
      'join-state1',
      2,
    );
    for (const claim of claims) await storeClaim(job, claim, compressed);
    const plan = await job.beginComplete();
    if (!plan.ok || plan.value.kind !== 'inline')
      throw new Error('plan: ' + JSON.stringify(plan));

    expect(unwrapRpc(await job.join(claims))).toEqual({
      kind: 'state',
      state: 'COMPLETING',
    });
  }, 60000);
});

async function encodedRequest(
  cache: string,
  storeHash: string,
  compress: (raw: Uint8Array) => Uint8Array,
): Promise<{ input: EncodedUploadRequest; compressed: Uint8Array[] }> {
  const nar = narOfFile(encoder.encode('hello merged encoded push'));
  const middle = Math.floor(nar.length / 2);
  const compressed = [nar.slice(0, middle), nar.slice(middle)].map(compress);
  const chunks = await Promise.all(
    [nar.slice(0, middle), nar.slice(middle)].map(async (raw, index) => ({
      raw_hash: await sha256Nix(raw),
      raw_size: raw.length,
      compressed_hash: await sha256Nix(compressed[index]!),
      compressed_size: compressed[index]!.length,
    })),
  );
  return {
    input: {
      manifest: {
        cache,
        store_hash: storeHash,
        store_path: `/nix/store/${storeHash}-hello`,
        nar_hash: await sha256Nix(nar),
        nar_size: nar.length,
        references: [],
      },
      encoding_id: 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1',
      chunks: [chunks[0]!, chunks[1]!],
    },
    compressed,
  };
}

const zstd = (raw: Uint8Array) => new Uint8Array(zstdCompressSync(raw));
const zstdOtherBuild = (raw: Uint8Array) =>
  new Uint8Array(
    zstdCompressSync(raw, { params: { [constants.ZSTD_c_checksumFlag]: 1 } }),
  );

describe('merged encoded pushes', () => {
  it('lets an identical encoder finish the upload it merged into', async () => {
    const cache = 'flow-encoded-join';
    const storeHash = '4'.repeat(32);
    await setupCache(cache, 'encoded-join1');
    const state = await getCache(env, cache);
    const first = await encodedRequest(cache, storeHash, zstd);
    const opened = await openEncoded(env, state, 'op-encoded-a', first.input);
    expect(opened.merged).toBe(false);
    expect(opened.missing_chunks).toEqual(
      first.input.chunks.map((chunk) => chunk.raw_hash).sort(),
    );
    const job = env.UPLOAD_JOB.get(env.UPLOAD_JOB.idFromString(opened.id));
    await storeChunk(
      env,
      job,
      first.input.chunks[0]!.raw_hash,
      first.compressed[0]!,
    );

    const merged = await openEncoded(
      env,
      state,
      'op-encoded-b',
      (await encodedRequest(cache, storeHash, zstd)).input,
    );
    expect(merged).toMatchObject({
      id: opened.id,
      status: 'UPLOADING',
      merged: true,
    });
    expect(merged.missing_chunks).toEqual([first.input.chunks[1]!.raw_hash]);
  }, 60000);

  it('gives a different encoder an upload of its own', async () => {
    const cache = 'flow-encoded-incompatible';
    const storeHash = '5'.repeat(32);
    const { coordinator } = await setupCache(cache, 'encoded-incompatible1');
    const state = await getCache(env, cache);
    const first = await encodedRequest(cache, storeHash, zstd);
    const opened = await openEncoded(env, state, 'op-encoded-a', first.input);
    const other = await encodedRequest(cache, storeHash, zstdOtherBuild);
    expect(other.input.chunks[0]!.compressed_hash).not.toBe(
      first.input.chunks[0]!.compressed_hash,
    );

    const own = await openEncoded(env, state, 'op-encoded-b', other.input);
    expect(own.merged).toBe(false);
    expect(own.id).not.toBe(opened.id);
    expect(own.status).toBe('UPLOADING');

    expect(
      await coordinator.pendingUploads({
        store_hashes: [storeHash],
        now: Math.floor(Date.now() / 1000),
      }),
    ).toEqual({
      ok: true,
      value: [{ store_hash: storeHash, upload_id: opened.id }],
    });
  }, 60000);
});

async function driveToInlineCompleting(tag: string) {
  const cache = `flow-stall-${tag}`;
  const { reference, coordinator } = await setupCache(cache, `stall-${tag}`);
  const driven = await openUpload(
    cache,
    reference,
    coordinator,
    `stall-${tag}`,
  );
  await env.CACHE_BUCKET.put(chunkKey(driven.rawHash), driven.compressed);
  expect((await driven.job.chunkStored(driven.rawHash)).ok).toBe(true);
  const plan = await driven.job.beginComplete();
  if (!plan.ok || plan.value.kind !== 'inline')
    throw new Error('plan: ' + JSON.stringify(plan));
  return { ...driven, chunksKey: plan.value.chunks_key, nar: plan.value.nar };
}

async function readAlarm(job: JobStub): Promise<number | null> {
  return runInDurableObject(
    job,
    async (_instance: unknown, state: DurableObjectState) => {
      return state.storage.getAlarm();
    },
  );
}

async function settleState(job: JobStub) {
  const state = await job.state();
  if (!state.ok) throw new Error('state: ' + JSON.stringify(state.error));
  return state.value;
}

describe('inline verification stall recovery', () => {
  it('schedules an alarm when inline completion starts', async () => {
    const { job } = await driveToInlineCompleting('alarm-set');
    const alarm = await readAlarm(job);
    expect(alarm).not.toBeNull();
    expect(
      Math.abs(alarm! - (Date.now() + INLINE_VERIFY_STALL_MS)),
    ).toBeLessThan(60_000);
  }, 60000);

  it('hands a stalled inline completion to the workflow when the alarm fires', async () => {
    const { job, jobId, chunksKey, nar } =
      await driveToInlineCompleting('alarm-fire');
    expect(await runDurableObjectAlarm(job)).toBe(true);
    expect(['QUEUED', 'PROCESSING']).toContain((await settleState(job)).status);
    const stored = await env.CACHE_BUCKET.get(chunksKey);
    expect(stored).not.toBeNull();
    expect(await stored!.json()).toEqual(chunkList(nar));
    const instance = await env.PROCESS_UPLOAD.get(jobId);
    expect((await instance.status()).status).toBe('running');
  }, 60000);

  it('clears the alarm once the upload finishes and ignores a stray one', async () => {
    const ready = await driveToInlineCompleting('alarm-ready');
    const verified = await verifyStoredNar(env.CACHE_BUCKET, ready.nar);
    const { result } = await storeManifest(env.CACHE_BUCKET, verified);
    const published = await ready.job.publishVerified(result, verified);
    if (!published.ok)
      throw new Error('publish: ' + JSON.stringify(published.error));
    expect(published.value.status).toBe('READY');
    expect(await runDurableObjectAlarm(ready.job)).toBe(false);
    await runInDurableObject(
      ready.job,
      (_instance, state: DurableObjectState) =>
        state.storage.setAlarm(Date.now() + 60_000),
    );
    expect(await runDurableObjectAlarm(ready.job)).toBe(true);
    expect((await settleState(ready.job)).status).toBe('READY');

    const failed = await driveToInlineCompleting('alarm-failed');
    const rejected = await failed.job.reject('stalled test');
    if (!rejected.ok)
      throw new Error('reject: ' + JSON.stringify(rejected.error));
    expect(rejected.value.status).toBe('FAILED');
    expect(await runDurableObjectAlarm(failed.job)).toBe(false);
    await runInDurableObject(
      failed.job,
      (_instance, state: DurableObjectState) =>
        state.storage.setAlarm(Date.now() + 60_000),
    );
    expect(await runDurableObjectAlarm(failed.job)).toBe(true);
    expect((await settleState(failed.job)).status).toBe('FAILED');
    expect(await env.CACHE_BUCKET.get(failed.chunksKey)).toBeNull();
  }, 60000);

  it('keeps a workflow-owned upload queued when publishVerified arrives late', async () => {
    const driven = await driveToInlineCompleting('late-publish');
    const verified = await verifyStoredNar(env.CACHE_BUCKET, driven.nar);
    const { result } = await storeManifest(env.CACHE_BUCKET, verified);
    expect(await runDurableObjectAlarm(driven.job)).toBe(true);
    expect(['QUEUED', 'PROCESSING']).toContain(
      (await settleState(driven.job)).status,
    );
    const published = await driven.job.publishVerified(result, verified);
    if (!published.ok)
      throw new Error('publish: ' + JSON.stringify(published.error));
    expect(['QUEUED', 'PROCESSING', 'PUBLISHING', 'READY']).toContain(
      published.value.status,
    );
  }, 60000);
});
