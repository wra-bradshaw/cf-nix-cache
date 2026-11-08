import verifierModule from '../../generated/verify.wasm';

export class InvalidEncodingError extends Error {}

interface Exports {
  memory: WebAssembly.Memory;
  verifier_new(): number;
  verifier_free(handle: number): void;
  verifier_input(handle: number, length: number): number;
  verifier_chunk(handle: number, rawSize: number, wholeNar: number): number;
  verifier_finish(handle: number): number;
  verifier_output(handle: number): number;
  verifier_output_len(handle: number): number;
}

function assertExports(exports: object): asserts exports is Exports {
  const wasm = exports as Partial<Exports> & { memory?: unknown };
  const missing = (
    [
      'memory',
      'verifier_new',
      'verifier_free',
      'verifier_input',
      'verifier_chunk',
      'verifier_finish',
      'verifier_output',
      'verifier_output_len',
    ] as const
  ).filter((name) =>
    name === 'memory'
      ? !(wasm.memory instanceof WebAssembly.Memory)
      : typeof wasm[name] !== 'function',
  );
  if (missing.length > 0)
    throw new Error(
      `verify.wasm is stale (missing: ${missing.join(', ')}); rebuild it with pnpm generate`,
    );
}

// A trap can leave memory inconsistent, so replace the instance after one.
let shared: Exports | undefined;

const decoder = new TextDecoder();

export const CHUNK_MAX_RAW_SIZE = 16 * 1024 * 1024;
export const CHUNK_MAX_COMPRESSED_SIZE = 17 * 1024 * 1024;

export const RAW_HASH = /^sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}$/;

export function assertValidRawHash(hash: unknown): asserts hash is string {
  if (typeof hash !== 'string' || !RAW_HASH.test(hash))
    throw new InvalidEncodingError(`chunk hash ${String(hash)} is invalid`);
}

function nullInputMessage(length: number): string {
  return length === 0 ? 'chunk is empty' : 'chunk is too large';
}

export class ChunkVerifier {
  private readonly wasm: Exports;
  private handle: number | undefined;

  constructor() {
    shared ??= (() => {
      const exports = new WebAssembly.Instance(verifierModule, {})
        .exports as unknown as Exports;
      assertExports(exports);
      return exports;
    })();
    assertExports(shared);
    this.wasm = shared;
    const handle = this.wasm.verifier_new();
    if (handle === 0) throw new Error('chunk verifier is out of memory');
    this.handle = handle;
  }

  chunk(compressed: Uint8Array, rawSize: number, wholeNar = true): Uint8Array {
    if (
      !Number.isInteger(rawSize) ||
      rawSize < 1 ||
      rawSize > CHUNK_MAX_RAW_SIZE
    )
      throw new InvalidEncodingError(`chunk size ${rawSize} is out of range`);
    if (compressed.length === 0)
      throw new InvalidEncodingError('chunk is empty');
    if (compressed.length > CHUNK_MAX_COMPRESSED_SIZE)
      throw new InvalidEncodingError('chunk is too large');
    return this.run((wasm, handle) => {
      const pointer = wasm.verifier_input(handle, compressed.length);
      if (pointer === 0)
        throw new InvalidEncodingError(nullInputMessage(compressed.length));
      new Uint8Array(wasm.memory.buffer, pointer, compressed.length).set(
        compressed,
      );
      return wasm.verifier_chunk(handle, rawSize, wholeNar ? 1 : 0);
    });
  }

  finish(): number {
    const output = this.run((wasm, handle) => wasm.verifier_finish(handle));
    if (output.length !== 8)
      throw new InvalidEncodingError('NAR size is invalid');
    try {
      const size = new DataView(
        output.buffer,
        output.byteOffset,
        output.byteLength,
      ).getBigUint64(0, true);
      if (size > BigInt(Number.MAX_SAFE_INTEGER))
        throw new InvalidEncodingError('NAR size is invalid');
      return Number(size);
    } catch (error) {
      if (error instanceof RangeError)
        throw new InvalidEncodingError('NAR size is invalid');
      throw error;
    }
  }

  free(): void {
    if (this.handle !== undefined && shared === this.wasm)
      this.wasm.verifier_free(this.handle);
    this.handle = undefined;
  }

  private run(body: (wasm: Exports, handle: number) => number): Uint8Array {
    const { wasm, handle } = this;
    if (handle === undefined || shared !== wasm)
      throw new Error('chunk verifier is no longer usable');
    let status: number;
    let output: Uint8Array;
    try {
      status = body(wasm, handle);
      const outputLen = wasm.verifier_output_len(handle);
      output =
        outputLen === 0
          ? new Uint8Array(0)
          : new Uint8Array(
              wasm.memory.buffer,
              wasm.verifier_output(handle),
              outputLen,
            ).slice();
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) shared = undefined;
      throw error;
    }
    if (status !== 0) {
      if (output.length === 0) throw new Error('verifier is not initialized');
      throw new InvalidEncodingError(decoder.decode(output));
    }
    return output;
  }
}

export function decodeChunk(
  compressed: Uint8Array,
  rawSize: number,
): Uint8Array {
  const verifier = new ChunkVerifier();
  try {
    return verifier.chunk(compressed, rawSize, false);
  } finally {
    verifier.free();
  }
}
