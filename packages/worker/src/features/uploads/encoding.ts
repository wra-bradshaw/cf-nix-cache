import { NIX_BASE32 } from '../../shared/identifiers';
import { ENCODING_ID } from '../cache/types';
import { InvalidEncodingError, decodeChunk } from './verifier';

/** Largest raw chunk the encoding produces (CHUNK_MAX_SIZE).
 * Canonical value; must stay in sync with `CHUNK_MAX_RAW_SIZE` in
 * `crates/verify/src/lib.rs` (and `CHUNK_MAX_SIZE` in
 * `crates/cli/src/protocol/mod.rs`) and `CHUNK_MAX_RAW_SIZE` in
 * `verifier.ts`. The cross-module ties are asserted in `verifier.test.ts`
 * and `verify-stored.test.ts`. The cross-crate gate is the
 * `check-encoding-constants` CI step (`upload-nar.mts --check-drift`):
 * local `pnpm test` does not run it, so run that script locally when
 * touching these values.
 */
export const CHUNK_MAX_RAW_SIZE = 16 * 1024 * 1024;
/** zstd's worst case for a CHUNK_MAX_RAW_SIZE frame, rounded up.
 * Canonical value; must stay in sync with `CHUNK_MAX_COMPRESSED_SIZE` in
 * `crates/verify/src/lib.rs` and `verifier.ts` (see above).
 */
export const CHUNK_MAX_COMPRESSED_SIZE = 17 * 1024 * 1024;

export function chunkKey(rawHash: string): string {
  return `chunks/${ENCODING_ID}/${rawHash}.zst`;
}

export function manifestKey(narHash: string): string {
  return `manifests/${ENCODING_ID}/${narHash}.json`;
}

/** Nix's base32, which writes the hash from its last byte to its first. */
export function nixBase32(bytes: Uint8Array): string {
  const length = Math.ceil((bytes.length * 8) / 5);
  let out = '';
  for (let n = length - 1; n >= 0; n -= 1) {
    const bit = n * 5;
    const index = Math.floor(bit / 8);
    const offset = bit % 8;
    const value =
      (bytes[index]! >> offset) |
      (index + 1 < bytes.length ? bytes[index + 1]! << (8 - offset) : 0);
    out += NIX_BASE32[value & 0x1f];
  }
  return out;
}

export async function sha256Nix(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${nixBase32(new Uint8Array(digest))}`;
}

export interface ChunkClaim {
  raw_hash: string;
  raw_size: number;
  compressed_hash: string;
  compressed_size: number;
}

/**
 * Verification level 1: an uploaded chunk is what the session says it is.
 * This must pass before the chunk is written to its content-addressed key,
 * where the first writer wins for good.
 */
export async function verifyChunk(
  compressed: Uint8Array,
  claim: ChunkClaim,
): Promise<void> {
  if (compressed.length !== claim.compressed_size)
    throw new InvalidEncodingError(
      `chunk is ${compressed.length} bytes, not ${claim.compressed_size}`,
    );
  if ((await sha256Nix(compressed)) !== claim.compressed_hash)
    throw new InvalidEncodingError('compressed chunk hash does not match');
  const raw = decodeChunk(compressed, claim.raw_size);
  if ((await sha256Nix(raw)) !== claim.raw_hash)
    throw new InvalidEncodingError('decoded chunk hash does not match');
}
