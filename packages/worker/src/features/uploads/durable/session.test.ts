import { zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { chunkKey, sha256Nix } from '../encoding';
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

async function clearAlarm(job: JobStub): Promise<void> {
  await runInDurableObject(
    job,
    async (_instance: unknown, state: DurableObjectState) => {
      await state.storage.deleteAlarm();
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
    expect((await settleState(job)).status).toBe('QUEUED');
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

  it('reschedules a missing alarm from state() without moving an existing one', async () => {
    const { job } = await driveToInlineCompleting('alarm-reschedule');
    await clearAlarm(job);
    expect(await readAlarm(job)).toBeNull();
    expect((await settleState(job)).status).toBe('COMPLETING');
    const first = await readAlarm(job);
    expect(first).not.toBeNull();
    expect(
      Math.abs(first! - (Date.now() + INLINE_VERIFY_STALL_MS)),
    ).toBeLessThan(60_000);
    expect((await settleState(job)).status).toBe('COMPLETING');
    expect(await readAlarm(job)).toBe(first);
  }, 60000);

  it('keeps a workflow-owned upload queued when publishVerified arrives late', async () => {
    const driven = await driveToInlineCompleting('late-publish');
    const verified = await verifyStoredNar(env.CACHE_BUCKET, driven.nar);
    const { result } = await storeManifest(env.CACHE_BUCKET, verified);
    expect(await runDurableObjectAlarm(driven.job)).toBe(true);
    expect((await settleState(driven.job)).status).toBe('QUEUED');
    const published = await driven.job.publishVerified(result, verified);
    if (!published.ok)
      throw new Error('publish: ' + JSON.stringify(published.error));
    expect(['QUEUED', 'PROCESSING', 'PUBLISHING', 'READY']).toContain(
      published.value.status,
    );
  }, 60000);
});
