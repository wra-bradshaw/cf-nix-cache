import { zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  InvalidEncodingError,
  decodeChunk,
  nixBase32,
  sha256Nix,
  verifyChunk,
} from './encoding';

const encoder = new TextEncoder();

function compress(raw: Uint8Array): Uint8Array {
  return new Uint8Array(zstdCompressSync(raw));
}

describe('client-encoded chunks', () => {
  it('writes hashes in Nix base32', async () => {
    // `nix hash file --type sha256 --base32 /dev/null`
    expect(await sha256Nix(new Uint8Array())).toBe(
      'sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73',
    );
    expect(nixBase32(new Uint8Array([0xff]))).toBe('7z');
  });

  it('accepts a chunk that matches its claim', async () => {
    const raw = encoder.encode('hello world '.repeat(1000));
    const compressed = compress(raw);
    await expect(
      verifyChunk(compressed, {
        raw_hash: await sha256Nix(raw),
        raw_size: raw.length,
        compressed_hash: await sha256Nix(compressed),
        compressed_size: compressed.length,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects a chunk whose content differs from its raw hash', async () => {
    const raw = encoder.encode('hello world '.repeat(1000));
    const other = encoder.encode('HELLO WORLD '.repeat(1000));
    const compressed = compress(other);
    await expect(
      verifyChunk(compressed, {
        raw_hash: await sha256Nix(raw),
        raw_size: raw.length,
        compressed_hash: await sha256Nix(compressed),
        compressed_size: compressed.length,
      }),
    ).rejects.toThrow('decoded chunk hash does not match');
  });

  it('rejects frames that decode to more or fewer bytes than declared', () => {
    const raw = encoder.encode('x'.repeat(5000));
    const compressed = compress(raw);
    expect(() => decodeChunk(compressed, raw.length - 1)).toThrow(
      InvalidEncodingError,
    );
    expect(() => decodeChunk(compressed, raw.length + 1)).toThrow(
      InvalidEncodingError,
    );
    expect(decodeChunk(compressed, raw.length)).toEqual(raw);
  });

  it('rejects data that is not zstd', () => {
    expect(() => decodeChunk(encoder.encode('not zstd'), 8)).toThrow(
      InvalidEncodingError,
    );
  });
});
