import { Decompress } from 'fzstd';
import { NIX_BASE32 } from '../../shared/identifiers';
import { ENCODING_ID } from '../cache/types';

/** Largest raw chunk the encoding produces (CHUNK_MAX_SIZE). */
export const CHUNK_MAX_RAW_SIZE = 16 * 1024 * 1024;
/** zstd's worst case for a CHUNK_MAX_RAW_SIZE frame, rounded up. */
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

/** Raised for content that can never be accepted, as opposed to a failure. */
export class InvalidEncodingError extends Error {}

/**
 * Decodes a compressed chunk and checks it holds exactly `rawSize` bytes. The
 * output is counted as it is produced, so a frame that expands past its
 * declared size is stopped there rather than decoded in full.
 */
export function decodeChunk(
  compressed: Uint8Array,
  rawSize: number,
): Uint8Array {
  const raw = new Uint8Array(rawSize);
  let length = 0;
  const decoder = new Decompress((data) => {
    if (length + data.length > rawSize)
      throw new InvalidEncodingError(
        `chunk decodes to more than ${rawSize} bytes`,
      );
    raw.set(data, length);
    length += data.length;
  });
  try {
    decoder.push(compressed, true);
  } catch (error) {
    if (error instanceof InvalidEncodingError) throw error;
    throw new InvalidEncodingError(
      `chunk is not valid zstd: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (length !== rawSize)
    throw new InvalidEncodingError(
      `chunk decodes to ${length} bytes, not ${rawSize}`,
    );
  return raw;
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
