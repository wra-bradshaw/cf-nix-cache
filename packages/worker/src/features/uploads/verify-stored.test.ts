import { createHash } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  InvalidEncodingError,
  chunkKey,
  nixBase32,
  sha256Nix,
} from './encoding';
import { storeManifest, verifyStoredNar } from './verify-stored';

/** workerd's streaming digest, which Node lacks. */
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

function narOfFile(contents: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (const field of [
    encoder.encode('nix-archive-1'),
    encoder.encode('('),
    encoder.encode('type'),
    encoder.encode('regular'),
    encoder.encode('contents'),
    contents,
    encoder.encode(')'),
  ]) {
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(field.length), true);
    out.push(
      ...length,
      ...field,
      ...new Array((8 - (field.length % 8)) % 8).fill(0),
    );
  }
  return new Uint8Array(out);
}

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
});
