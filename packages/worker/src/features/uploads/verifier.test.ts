import { zstdCompressSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import verifierModule from '../../generated/verify.wasm';
import {
  CHUNK_MAX_COMPRESSED_SIZE as VERIFIER_MAX_COMPRESSED,
  CHUNK_MAX_RAW_SIZE as VERIFIER_MAX_RAW,
  ChunkVerifier,
  InvalidEncodingError,
  RAW_HASH,
  assertValidRawHash,
} from './verifier';
import {
  CHUNK_MAX_COMPRESSED_SIZE as ENCODING_MAX_COMPRESSED,
  CHUNK_MAX_RAW_SIZE as ENCODING_MAX_RAW,
} from './encoding';
import { NAR_HASH } from './encoded-routes';

const encoder = new TextEncoder();

function nar(...fields: string[]): Uint8Array {
  const parts: number[] = [];
  for (const field of fields) {
    const bytes = encoder.encode(field);
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(bytes.length), true);
    parts.push(
      ...length,
      ...bytes,
      ...new Array((8 - (bytes.length % 8)) % 8).fill(0),
    );
  }
  return new Uint8Array(parts);
}

const file = (name: string, contents: string) =>
  ['entry', '(', 'name', name, 'node'].concat([
    '(',
    'type',
    'regular',
    'contents',
    contents,
    ')',
    ')',
  ]);

const tree = nar(
  'nix-archive-1',
  '(',
  'type',
  'directory',
  ...file('a', 'hello'),
  ...['entry', '(', 'name', 'b', 'node'],
  ...['(', 'type', 'symlink', 'target', 'a', ')', ')'],
  ')',
);

const compress = (raw: Uint8Array) => new Uint8Array(zstdCompressSync(raw));

function verify(bytes: Uint8Array, splits: number[] = []): number {
  const verifier = new ChunkVerifier();
  try {
    let offset = 0;
    for (const end of [...splits, bytes.length]) {
      const raw = bytes.slice(offset, end);
      expect(verifier.chunk(compress(raw), raw.length)).toEqual(raw);
      offset = end;
    }
    return verifier.finish();
  } finally {
    verifier.free();
  }
}

describe('the WebAssembly chunk verifier', () => {
  it('decodes chunks and validates the NAR across chunk boundaries', () => {
    expect(verify(tree)).toBe(tree.length);
    expect(verify(tree, [3, 64, 65])).toBe(tree.length);
  });

  it('reports invalid content as InvalidEncodingError', () => {
    const unsorted = nar(
      'nix-archive-1',
      '(',
      'type',
      'directory',
      ...file('b', ''),
      ...file('a', ''),
      ')',
    );
    expect(() => verify(unsorted)).toThrow(/not sorted/);
    expect(() => verify(tree.slice(0, tree.length - 8))).toThrow(/truncated/);
    expect(() =>
      verify(new Uint8Array([...tree, ...new Uint8Array(8)])),
    ).toThrow(/trailing/);
    expect(() => verify(encoder.encode('not a NAR'))).toThrow(
      InvalidEncodingError,
    );
  });

  it('can be used again after rejecting a chunk', () => {
    const verifier = new ChunkVerifier();
    expect(() => verifier.chunk(encoder.encode('not zstd'), 8)).toThrow(
      /not valid zstd/,
    );
    verifier.free();
    expect(verify(tree)).toBe(tree.length);
  });

  it('rejects out-of-range sizes before calling into wasm', () => {
    const verifier = new ChunkVerifier();
    try {
      const raw = new Uint8Array([1, 2, 3, 4]);
      const compressed = compress(raw);
      for (const rawSize of [0, -1, 1.5, NaN, 16 * 1024 * 1024 + 1]) {
        expect(() => verifier.chunk(compressed, rawSize)).toThrow(
          /out of range/,
        );
      }
      expect(() => verifier.chunk(new Uint8Array(0), 4)).toThrow(/empty/);
    } finally {
      verifier.free();
    }
  });

  it('rejects oversize input without decoding', () => {
    const verifier = new ChunkVerifier();
    try {
      const oversize = new Uint8Array(17 * 1024 * 1024 + 1);
      expect(() => verifier.chunk(oversize, 1)).toThrow(/too large/);
    } finally {
      verifier.free();
    }
  });

  it('seals the verifier after a successful finish', () => {
    const verifier = new ChunkVerifier();
    try {
      const raw = tree.slice(0, 64);
      expect(verifier.chunk(compress(raw), raw.length)).toEqual(raw);
      const rest = tree.slice(64);
      expect(verifier.chunk(compress(rest), rest.length)).toEqual(rest);
      expect(verifier.finish()).toBe(tree.length);
      expect(() => verifier.finish()).toThrow(/already finished/);
      const extra = compress(tree.slice(0, 16));
      expect(() => verifier.chunk(extra, 16)).toThrow(/already finished/);
    } finally {
      verifier.free();
    }
  });

  it('does not seal the verifier after a failed finish', () => {
    const verifier = new ChunkVerifier();
    try {
      const raw = tree.slice(0, 64);
      expect(verifier.chunk(compress(raw), raw.length, false)).toEqual(raw);
      expect(() => verifier.finish()).toThrow(/truncated/);
      const head = tree.slice(0, 64);
      const tail = tree.slice(64);
      expect(verifier.chunk(compress(head), head.length)).toEqual(head);
      expect(verifier.chunk(compress(tail), tail.length)).toEqual(tail);
      expect(verifier.finish()).toBe(tree.length);
    } finally {
      verifier.free();
    }
  });

  it('stays in sync with the encoding limits', () => {
    expect(VERIFIER_MAX_RAW).toBe(ENCODING_MAX_RAW);
    expect(VERIFIER_MAX_COMPRESSED).toBe(ENCODING_MAX_COMPRESSED);
    expect(VERIFIER_MAX_RAW).toBe(16 * 1024 * 1024);
    expect(VERIFIER_MAX_COMPRESSED).toBe(17 * 1024 * 1024);
  });

  it('pins the chunk-hash shape shared with the upload routes', () => {
    expect(NAR_HASH.source).toBe(RAW_HASH.source);
    expect(RAW_HASH.source).toBe('^sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}$');
    expect(() => assertValidRawHash(`sha256:${'a'.repeat(52)}`)).not.toThrow();
    for (const bad of [
      `sha256:${'a'.repeat(51)}`,
      `sha256:${'a'.repeat(53)}`,
      `sha256:${'e'.repeat(52)}`,
      `SHA256:${'a'.repeat(52)}`,
      42,
      null,
    ]) {
      expect(() => assertValidRawHash(bad)).toThrow(InvalidEncodingError);
    }
  });

  it('rejects a symlink target containing NUL', () => {
    const bad = nar(
      'nix-archive-1',
      '(',
      'type',
      'symlink',
      'target',
      'a\u0000b',
      ')',
    );
    expect(() => verify(bad)).toThrow(/invalid symlink target/);
  });

  it('maps a truncated size output to a permanent error', () => {
    const verifier = new ChunkVerifier();
    try {
      vi.spyOn(
        verifier as unknown as { run: () => Uint8Array },
        'run',
      ).mockReturnValue(new Uint8Array(4));
      expect(() => verifier.finish()).toThrow(InvalidEncodingError);
      expect(() => verifier.finish()).toThrow('NAR size is invalid');
    } finally {
      verifier.free();
    }
  });

  it('pins the null-handle guard (fails on stale verify.wasm)', () => {
    const exports = new WebAssembly.Instance(verifierModule, {})
      .exports as unknown as {
      memory: WebAssembly.Memory;
      verifier_chunk(handle: number, rawSize: number, wholeNar: number): number;
      verifier_finish(handle: number): number;
      verifier_output(handle: number): number;
      verifier_output_len(handle: number): number;
    };
    expect(exports.verifier_chunk(0, 1, 1)).toBe(1);
    expect(exports.verifier_finish(0)).toBe(1);
    const length = exports.verifier_output_len(0);
    expect(length).toBeGreaterThan(0);
    const bytes = new Uint8Array(
      exports.memory.buffer,
      exports.verifier_output(0),
      length,
    );
    expect(new TextDecoder().decode(bytes)).toMatch(/not initialized/);
  });
});
