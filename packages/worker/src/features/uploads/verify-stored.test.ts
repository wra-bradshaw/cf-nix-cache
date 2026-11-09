import { createHash } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CHUNK_MAX_COMPRESSED_SIZE,
  CHUNK_MAX_RAW_SIZE,
  chunkKey,
  nixBase32,
  sha256Nix,
} from './encoding';
import { ChunkVerifier, InvalidEncodingError } from './verifier';
import { ENCODING_ID } from '../cache/types';
import type { ProcessJob } from './types';
import {
  CHUNK_LIST_MAX_BYTES,
  CHUNK_LIST_MAX_CHUNKS,
  chunkList,
  processUpload,
  readManifest,
  storeManifest,
  verifyStoredNar,
} from './verify-stored';
import { MAX_CHUNKS_PER_UPLOAD } from './encoded';
import { UploadJobLifecycle } from './durable/job-lifecycle';
import { narOfFile } from './test-helpers';

class DigestStream extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;
  constructor(algorithm: string) {
    const hash = createHash(algorithm.replace('-', '').toLowerCase());
    let resolve!: (value: ArrayBuffer) => void;
    const digest = new Promise<ArrayBuffer>((done) => (resolve = done));
    super({
      write: (chunk) => void hash.update(chunk),
      close: () => resolve(new Uint8Array(hash.digest()).buffer),
    });
    this.digest = digest;
  }
}

beforeAll(() => {
  (crypto as unknown as { DigestStream: unknown }).DigestStream = DigestStream;
});

const encoder = new TextEncoder();

function bucket(objects: Map<string, Uint8Array | string>): R2Bucket {
  return {
    get: async (key: string) => {
      const value = objects.get(key);
      if (value === undefined) return null;
      const bytes = typeof value === 'string' ? encoder.encode(value) : value;
      return {
        size: bytes.length,
        arrayBuffer: async () => bytes.slice().buffer,
        text: async () => new TextDecoder().decode(bytes),
      };
    },
    put: async (key: string, value: string, options: R2PutOptions) => {
      if (options.onlyIf && objects.has(key)) return null;
      objects.set(key, value);
      return {};
    },
  } as unknown as R2Bucket;
}

async function stored(nar: Uint8Array, splits: number[]) {
  const objects = new Map<string, Uint8Array | string>();
  const chunks = [];
  let offset = 0;
  for (const end of [...splits, nar.length]) {
    const raw = nar.slice(offset, end);
    offset = end;
    const rawHash = await sha256Nix(raw);
    objects.set(chunkKey(rawHash), new Uint8Array(zstdCompressSync(raw)));
    chunks.push({ raw_hash: rawHash, raw_size: raw.length });
  }
  return {
    objects,
    nar: { nar_hash: await sha256Nix(nar), nar_size: nar.length, chunks },
  };
}

describe('verifying stored chunks', () => {
  it('builds the manifest from the stored compressed bytes', async () => {
    const nar = narOfFile(encoder.encode('hello world\n'.repeat(500)));
    const { objects, nar: claim } = await stored(nar, [100, 3000]);
    const manifest = await verifyStoredNar(bucket(objects), claim);
    const concatenated = Buffer.concat(
      manifest.chunks.map((chunk) => objects.get(chunk.key) as Uint8Array),
    );
    expect(manifest.file_size).toBe(concatenated.length);
    expect(manifest.file_hash).toBe(
      `sha256:${nixBase32(createHash('sha256').update(concatenated).digest())}`,
    );
    expect(manifest.chunks.map((chunk) => chunk.raw_size)).toEqual([
      100,
      2900,
      nar.length - 3000,
    ]);
  });

  it('accepts a repeated chunk and reads back byte-identical', async () => {
    const nar = narOfFile(encoder.encode('h'.repeat(6000)));
    const { objects, nar: claim } = await stored(nar, [500, 1500, 2500]);
    expect(claim.chunks).toHaveLength(4);
    expect(claim.chunks[1]!.raw_hash).toBe(claim.chunks[2]!.raw_hash);
    const store = bucket(objects);
    const manifest = await verifyStoredNar(store, claim);
    expect(manifest.chunks.map((chunk) => chunk.raw_hash)).toEqual(
      claim.chunks.map((chunk) => chunk.raw_hash),
    );
    expect(manifest.nar_hash).toBe(claim.nar_hash);
    expect(manifest.file_size).toBe(
      manifest.chunks.reduce((sum, chunk) => sum + chunk.compressed_size, 0),
    );
    const { result, manifest: reread } = await storeManifest(store, manifest);
    expect(result.deduplicated).toBe(false);
    expect(reread.chunks).toHaveLength(4);
    const roundTripped = await readManifest(
      store,
      result.manifest_key,
      claim.nar_hash,
      claim.nar_size,
    );
    expect(roundTripped.chunks.map((chunk) => chunk.raw_hash)).toEqual(
      claim.chunks.map((chunk) => chunk.raw_hash),
    );
  });

  it('rejects chunks that do not make up the declared NAR', async () => {
    const nar = narOfFile(encoder.encode('hello'));
    const { objects, nar: claim } = await stored(nar, []);
    await expect(
      verifyStoredNar(bucket(objects), {
        ...claim,
        nar_hash: await sha256Nix(encoder.encode('other')),
      }),
    ).rejects.toThrow(InvalidEncodingError);
    const notNar = await stored(encoder.encode('just some bytes!'), []);
    await expect(
      verifyStoredNar(bucket(notNar.objects), notNar.nar),
    ).rejects.toThrow('invalid NAR archive');
  });

  it('keeps an existing manifest for the same NAR', async () => {
    const nar = narOfFile(encoder.encode('hello'));
    const { objects, nar: claim } = await stored(nar, []);
    const store = bucket(objects);
    const manifest = await verifyStoredNar(store, claim);
    expect((await storeManifest(store, manifest)).result).toMatchObject({
      deduplicated: false,
    });
    const again = await storeManifest(store, { ...manifest, created_at: 2 });
    expect(again.result).toMatchObject({ deduplicated: true });
    expect(again.manifest.created_at).toBe(manifest.created_at);
  });

  it('rejects a stored manifest with too many chunks', async () => {
    const hash = `sha256:${'a'.repeat(52)}`;
    const key = `chunks/${ENCODING_ID}/${hash}.zst`;
    const entry = {
      raw_hash: hash,
      raw_size: 1,
      compressed_hash: hash,
      compressed_size: 1,
      key,
    };
    const manifest = {
      encoding_id: ENCODING_ID,
      nar_hash: hash,
      nar_size: CHUNK_LIST_MAX_CHUNKS + 1,
      file_hash: hash,
      file_size: CHUNK_LIST_MAX_CHUNKS + 1,
      chunks: Array.from({ length: CHUNK_LIST_MAX_CHUNKS + 1 }, () => ({
        ...entry,
      })),
      processing_version: 'worker-v2',
      created_at: 1,
    };
    const manifestKey = `manifests/${ENCODING_ID}/${hash}.json`;
    const objects = new Map<string, Uint8Array | string>();
    objects.set(manifestKey, JSON.stringify(manifest));
    await expect(
      readManifest(bucket(objects), manifestKey, hash, manifest.nar_size),
    ).rejects.toThrow('too many chunks');
  });
});

describe('processing an upload from its chunk list', () => {
  const job = (claim: { nar_hash: string; nar_size: number }): ProcessJob => ({
    job_id: 'job',
    chunks_key: 'staging/job.chunks.json',
    nar_hash: claim.nar_hash,
    nar_size: claim.nar_size,
    encoding_id: ENCODING_ID,
  });

  it('verifies the listed chunks and stores the manifest', async () => {
    const nar = narOfFile(encoder.encode('hello world\n'.repeat(500)));
    const { objects, nar: claim } = await stored(nar, [1000]);
    objects.set('staging/job.chunks.json', JSON.stringify(chunkList(claim)));
    const result = await processUpload(bucket(objects), job(claim));
    expect(result).toEqual({
      manifest_key: `manifests/${ENCODING_ID}/${claim.nar_hash}`.concat(
        '.json',
      ),
      deduplicated: false,
    });
    expect(objects.has(result.manifest_key)).toBe(true);
    expect(await processUpload(bucket(objects), job(claim))).toMatchObject({
      deduplicated: true,
    });
  });

  it('verifies a chunk list that repeats a chunk', async () => {
    const nar = narOfFile(encoder.encode('h'.repeat(6000)));
    const { objects, nar: claim } = await stored(nar, [500, 1500, 2500]);
    expect(claim.chunks[1]!.raw_hash).toBe(claim.chunks[2]!.raw_hash);
    objects.set('staging/job.chunks.json', JSON.stringify(chunkList(claim)));
    const result = await processUpload(bucket(objects), job(claim));
    expect(result.deduplicated).toBe(false);
  });

  it('rejects a chunk list that repeats a chunk inconsistently', async () => {
    const nar = narOfFile(encoder.encode('h'.repeat(6000)));
    const { objects, nar: claim } = await stored(nar, [500, 1500, 2500]);
    const store = bucket(objects);
    const list = chunkList(claim);
    const conflicting = {
      ...list,
      chunks: list.chunks.map((chunk, index) =>
        index === 2 ? { ...chunk, raw_size: chunk.raw_size + 1 } : chunk,
      ),
    };
    objects.set('staging/job.chunks.json', JSON.stringify(conflicting));
    await expect(processUpload(store, job(claim))).rejects.toThrow(
      'conflicting',
    );
  });

  it('rejects a chunk list that does not match the upload', async () => {
    const nar = narOfFile(encoder.encode('hello'));
    const { objects, nar: claim } = await stored(nar, []);
    const store = bucket(objects);
    const list = chunkList(claim);
    for (const [bad, message] of [
      [{ ...list, nar_size: list.nar_size + 1 }, 'does not match'],
      [{ ...list, chunks: [] }, 'chunk list is empty'],
      [
        { ...list, chunks: [{ ...list.chunks[0]!, key: 'chunks/elsewhere' }] },
        'invalid chunk',
      ],
    ] as const) {
      objects.set('staging/job.chunks.json', JSON.stringify(bad));
      await expect(processUpload(store, job(claim))).rejects.toThrow(message);
    }
    objects.set('staging/job.chunks.json', '{');
    await expect(processUpload(store, job(claim))).rejects.toThrow(
      InvalidEncodingError,
    );
  });

  it('rejects out-of-range raw sizes before touching WASM', async () => {
    const nar = narOfFile(encoder.encode('hello'));
    const { objects, nar: claim } = await stored(nar, []);
    for (const raw_size of [
      0,
      -1,
      17 * 1024 * 1024,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await expect(
        verifyStoredNar(bucket(objects), {
          ...claim,
          chunks: [{ ...claim.chunks[0]!, raw_size }],
        }),
      ).rejects.toThrow('invalid size');
    }
  });

  it('rejects an oversized chunk list payload before parsing', async () => {
    const nar = narOfFile(encoder.encode('hello'));
    const { objects, nar: claim } = await stored(nar, []);
    objects.set(
      'staging/job.chunks.json',
      'x'.repeat(CHUNK_LIST_MAX_BYTES + 1),
    );
    await expect(processUpload(bucket(objects), job(claim))).rejects.toThrow(
      'too large',
    );
  });

  it('fits the largest legal chunk list inside the byte cap', () => {
    expect(CHUNK_LIST_MAX_BYTES).toBe(CHUNK_LIST_MAX_CHUNKS * 256);
    expect(MAX_CHUNKS_PER_UPLOAD).toBe(CHUNK_LIST_MAX_CHUNKS);
    const rawHash = `sha256:${'a'.repeat(52)}`;
    const key = `chunks/${ENCODING_ID}/${rawHash}.zst`;
    const chunks = Array.from({ length: CHUNK_LIST_MAX_CHUNKS }, () => ({
      raw_hash: rawHash,
      raw_size: 1024,
      key,
    }));
    const text = JSON.stringify({
      encoding_id: ENCODING_ID,
      nar_hash: rawHash,
      nar_size: CHUNK_LIST_MAX_CHUNKS * 1024,
      chunks,
    });
    expect(text.length).toBeLessThanOrEqual(CHUNK_LIST_MAX_BYTES);
    const realistic = JSON.stringify({
      encoding_id: ENCODING_ID,
      nar_hash: rawHash,
      nar_size: 10240 * 1024 * 1024,
      chunks: Array.from({ length: 10240 }, () => ({
        raw_hash: rawHash,
        raw_size: 1024 * 1024,
        key,
      })),
    });
    expect(realistic.length).toBeLessThanOrEqual(CHUNK_LIST_MAX_BYTES);
  });

  it('keeps the chunk limits in sync with the wasm verifier', () => {
    const verifier = new ChunkVerifier();
    try {
      const raw = new Uint8Array([1, 2, 3, 4]);
      const compressed = new Uint8Array(zstdCompressSync(raw));
      expect(() => verifier.chunk(compressed, CHUNK_MAX_RAW_SIZE + 1)).toThrow(
        /out of range/,
      );
      expect(() =>
        verifier.chunk(new Uint8Array(CHUNK_MAX_COMPRESSED_SIZE + 1), 1),
      ).toThrow(/too large/);
    } finally {
      verifier.free();
    }
  });

  it('maps a truncated wasm size output to a permanent error', async () => {
    const nar = narOfFile(encoder.encode('hello'));
    const { objects, nar: claim } = await stored(nar, []);
    const finish = vi
      .spyOn(ChunkVerifier.prototype, 'finish')
      .mockImplementation(() => {
        throw new InvalidEncodingError('NAR size is invalid');
      });
    try {
      await expect(verifyStoredNar(bucket(objects), claim)).rejects.toThrow(
        InvalidEncodingError,
      );
      await expect(verifyStoredNar(bucket(objects), claim)).rejects.toThrow(
        'NAR size is invalid',
      );
    } finally {
      finish.mockRestore();
    }
  });

  it('reports a lost processing claim instead of succeeding', async () => {
    let reads = 0;
    const fakeStorage = {
      row: () => {
        reads += 1;
        if (reads === 1) return { job_id: 'job', state: 'QUEUED' };
        return { job_id: 'job', state: 'FAILED' };
      },
      setState: () => false,
    };
    const lifecycle = new UploadJobLifecycle(
      {} as DurableObjectState,
      {} as Env,
      fakeStorage as never,
    );
    const result = await lifecycle.processing();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_transition');
  });

  it('treats an already-claimed upload as idempotent', async () => {
    let reads = 0;
    const fakeStorage = {
      row: () => {
        reads += 1;
        if (reads === 1) return { job_id: 'job', state: 'QUEUED' };
        return { job_id: 'job', state: 'PROCESSING' };
      },
      setState: () => false,
    };
    const lifecycle = new UploadJobLifecycle(
      {} as DurableObjectState,
      {} as Env,
      fakeStorage as never,
    );
    expect((await lifecycle.processing()).ok).toBe(true);
  });

  it('reports a lost abort race as a conflict', async () => {
    let reads = 0;
    const fakeStorage = {
      row: () => {
        reads += 1;
        if (reads === 1)
          return {
            job_id: 'job',
            state: 'QUEUED',
            manifest: { nar_hash: 'h', nar_size: 1 },
            error: null,
          };
        return {
          job_id: 'job',
          state: 'PROCESSING',
          manifest: { nar_hash: 'h', nar_size: 1 },
          error: null,
        };
      },
      setState: () => false,
    };
    const lifecycle = new UploadJobLifecycle(
      {} as DurableObjectState,
      {} as Env,
      fakeStorage as never,
    );
    const result = await lifecycle.abort();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_transition');
  });
});
