/**
 * The chunk decoder and NAR validator from `crates/verify`, compiled to
 * WebAssembly. It decodes each zstd chunk and checks the NAR's structure as
 * the chunks go by; hashing stays here, on native SHA-256, because
 * WebAssembly has no SHA instructions. See that crate's `ffi.rs` for the
 * calling convention.
 *
 * `src/generated/verify.wasm` is gitignored (see `.gitignore`) and rebuilt
 * from `crates/verify` by `scripts/build-verifier.mts` (`pnpm generate`,
 * which `pretest`, `precheck`, `prebuild`, `predev`, and `pree2e` all run;
 * CI runs those same scripts, so every check, test, and build uses a wasm
 * built from the current `ffi.rs`). The TypeScript pre-validation in `chunk`
 * below intentionally rejects empty and oversize input before it reaches
 * wasm, so for those two paths a stale `verify.wasm` is masked (the error
 * comes from here, not wasm). Staleness detection for every path therefore
 * relies solely on the constructor's export assert plus the behavioral pins
 * in `verifier.test.ts` (seal-after-finish and the null-handle message),
 * which fail on a stale module that still exports the same names but
 * predates the `ffi.rs` guards. Those two pins are what keep a stale local
 * build from being exercised silently.
 */
import verifierModule from '../../generated/verify.wasm';

/** Raised for content that can never be accepted, as opposed to a failure. */
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

/**
 * Fails fast on a stale `verify.wasm` that predates the current `ffi.rs`
 * (for example a checked-in build from before the null-handle guards).
 * Without this, a missing export would surface as an obscure
 * `TypeError` on first use rather than as a rebuild hint.
 */
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

/**
 * One instance per isolate. A trap (a panic, or running out of memory) can
 * leave its memory inconsistent, so it is replaced after one.
 */
let shared: Exports | undefined;

const decoder = new TextDecoder();

/**
 * Canonical chunk limits; must stay in sync with `CHUNK_MAX_RAW_SIZE` /
 * `CHUNK_MAX_COMPRESSED_SIZE` in `crates/verify/src/lib.rs` and
 * `CHUNK_MAX_RAW_SIZE` / `CHUNK_MAX_COMPRESSED_SIZE` in `encoding.ts`.
 * Duplicated here (rather than imported from `encoding.ts`, which imports
 * `decodeChunk` from this module) to avoid a module cycle. A single shared
 * home such as `shared/identifiers.ts` would also break the cycle; kept here
 * as canonical until that move, with the sync pinned by the ties asserted in
 * `verifier.test.ts` (which asserts they equal the `encoding.ts` limits).
 * The single cross-crate gate over all five homes (this file,
 * `encoding.ts`, `crates/verify/src/lib.rs`,
 * `crates/cli/src/protocol/mod.rs`, `bench/verify-worker/upload-nar.mts`)
 * is the `check-encoding-constants` CI step, which runs
 * `bench/verify-worker/upload-nar.mts --check-drift`. Local `pnpm test`
 * (via `pretest` → `generate`) does not run that drift check, so run
 * `node bench/verify-worker/upload-nar.mts --check-drift` locally when
 * touching these values; CI fails on any drift. The TypeScript-side copies
 * need no manual step: `verifier.test.ts` and `verify-stored.test.ts` pin
 * them equal and do run under local `pnpm test` — only the cross-crate
 * (Rust/CLI/bench) part relies on the manual script plus CI.
 */
export const CHUNK_MAX_RAW_SIZE = 16 * 1024 * 1024;
export const CHUNK_MAX_COMPRESSED_SIZE = 17 * 1024 * 1024;

/**
 * Nix sha256 hash in `sha256:<52-char-nix-base32>` form. Canonical home of
 * the pattern whose only remaining duplicate is the exported `NAR_HASH` in
 * `encoded-routes.ts`: that copy is kept (rather than imported from here)
 * because the routes module avoids pulling in the verifier's wasm import
 * (`encoded.ts` imports this copy), and a single shared home such as
 * `shared/identifiers.ts` is left for a later move. `verifier.test.ts` pins
 * both copies equal (and pins the shared shape), so local `pnpm test`
 * already covers the duplicate with no manual step; a change here must
 * update every copy. Validated before any R2 read so a malformed hash is a
 * permanent encoding error without I/O.
 */
export const RAW_HASH = /^sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}$/;

/** Rejects a malformed chunk hash before it becomes an R2 key. */
export function assertValidRawHash(hash: unknown): asserts hash is string {
  if (typeof hash !== 'string' || !RAW_HASH.test(hash))
    throw new InvalidEncodingError(`chunk hash ${String(hash)} is invalid`);
}

/**
 * Names which length made `verifier_input` return null: 0 means empty, any
 * other length means oversize (`ffi.rs` reports both through the same null
 * pointer, keeping the stable ABI). The wrapper's pre-validation rejects
 * empty input before reaching wasm, so null there is always "too large";
 * direct wasm users see null for either case and must check the length they
 * passed in — this helper is that check.
 */
export function nullInputMessage(length: number): string {
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
    // `Box::into_raw` only returns null on allocation failure. That is a
    // transient resource shortage, not content that can never be accepted,
    // so it surfaces as a retryable `Error` rather than an
    // `InvalidEncodingError` (which marks permanent encoding failures).
    if (handle === 0) throw new Error('chunk verifier is out of memory');
    this.handle = handle;
  }

  /**
   * Decodes one stored chunk, which must come to exactly `rawSize` bytes.
   * With `wholeNar` it is also the next chunk of the NAR being verified;
   * without, it is checked alone.
   */
  chunk(compressed: Uint8Array, rawSize: number, wholeNar = true): Uint8Array {
    // Validated here so an out-of-range size never crosses the JS→wasm
    // boundary, where it would truncate to 32 bits. This intentionally masks
    // a stale verify.wasm for these two cases (the error comes from here,
    // not wasm): staleness detection relies solely on the constructor's
    // export assert plus the behavioral pins in `verifier.test.ts`
    // (seal-after-finish and the null-handle message), which fail on a
    // stale module that still exports the same names.
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
      // Null from `verifier_input` means the input was empty or too large to
      // buffer: `ffi.rs` reports both through the same null pointer, and this
      // pre-validation distinguishes them (empty is rejected above, so null
      // here is "too large"; see `nullInputMessage`). Direct wasm users see
      // null for either case and must check the length themselves to tell
      // them apart.
      const pointer = wasm.verifier_input(handle, compressed.length);
      if (pointer === 0)
        throw new InvalidEncodingError(nullInputMessage(compressed.length));
      new Uint8Array(wasm.memory.buffer, pointer, compressed.length).set(
        compressed,
      );
      return wasm.verifier_chunk(handle, rawSize, wholeNar ? 1 : 0);
    });
  }

  /** Checks the NAR is complete and returns its size. */
  finish(): number {
    const output = this.run((wasm, handle) => wasm.verifier_finish(handle));
    // The FFI writes exactly 8 bytes (u64 LE) on success; anything else,
    // short or overlong (e.g. from a stale or faulty wasm), cannot be
    // accepted as a size.
    if (output.length !== 8)
      throw new InvalidEncodingError('NAR size is invalid');
    try {
      const size = new DataView(
        output.buffer,
        output.byteOffset,
        output.byteLength,
      ).getBigUint64(0, true);
      // `Number` loses precision past 2^53, so a u64 size above
      // `MAX_SAFE_INTEGER` could compare unequal to the declared NAR size
      // even when it matches. Reject it as invalid rather than comparing a
      // rounded value.
      if (size > BigInt(Number.MAX_SAFE_INTEGER))
        throw new InvalidEncodingError('NAR size is invalid');
      return Number(size);
    } catch (error) {
      // A short or missing size output means the NAR cannot be accepted;
      // map it to a permanent encoding error rather than leaking a RangeError.
      if (error instanceof RangeError)
        throw new InvalidEncodingError('NAR size is invalid');
      throw error;
    }
  }

  free(): void {
    // A handle from a replaced instance went with it.
    if (this.handle !== undefined && shared === this.wasm)
      this.wasm.verifier_free(this.handle);
    this.handle = undefined;
  }

  /** Calls into the instance and copies out its output. */
  private run(body: (wasm: Exports, handle: number) => number): Uint8Array {
    const { wasm, handle } = this;
    if (handle === undefined || shared !== wasm)
      throw new Error('chunk verifier is no longer usable');
    let status: number;
    let output: Uint8Array;
    try {
      status = body(wasm, handle);
      const outputLen = wasm.verifier_output_len(handle);
      // The wasm side returns null when there is no output; never
      // dereference it for a zero-length copy.
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
      // An empty output here means a stale wasm predating the `ffi.rs`
      // output contract (current `ffi.rs` always sets a message for invalid
      // content, including the static null-handle message, so even a null
      // handle surfaces as non-empty output). A stale module is a
      // wrapper/wasm mismatch, not content that can never be accepted, so it
      // surfaces as a retryable `Error` rather than a permanent
      // `InvalidEncodingError`.
      if (output.length === 0) throw new Error('verifier is not initialized');
      // `ffi.rs` always sets a message for invalid content, so a non-empty
      // output here is a permanent encoding failure.
      throw new InvalidEncodingError(decoder.decode(output));
    }
    return output;
  }
}

/** Decodes one chunk alone; it must come to exactly `rawSize` bytes. */
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
