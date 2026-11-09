import { NIX_BASE32 } from '../../shared/identifiers';
import { ENCODING_ID } from '../cache/types';
import { InvalidEncodingError, decodeChunk } from './verifier';

export const CHUNK_MAX_RAW_SIZE = 16 * 1024 * 1024;
export const CHUNK_MAX_COMPRESSED_SIZE = 17 * 1024 * 1024;

export function chunkKey(rawHash: string): string {
  return `chunks/${ENCODING_ID}/${rawHash}.zst`;
}

export function manifestKey(narHash: string): string {
  return `manifests/${ENCODING_ID}/${narHash}.json`;
}

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

export function chunkClaimsConflict(chunks: ChunkClaim[]): string | null {
  const seen = new Map<string, ChunkClaim>();
  for (const chunk of chunks) {
    const known = seen.get(chunk.raw_hash);
    if (!known) {
      seen.set(chunk.raw_hash, chunk);
      continue;
    }
    if (
      known.raw_size !== chunk.raw_size ||
      known.compressed_hash !== chunk.compressed_hash ||
      known.compressed_size !== chunk.compressed_size
    )
      return 'upload declares conflicting chunks';
  }
  return null;
}

export function uniqueCompressedSize(chunks: ChunkClaim[]): number {
  const seen = new Set<string>();
  let size = 0;
  for (const chunk of chunks) {
    if (seen.has(chunk.raw_hash)) continue;
    seen.add(chunk.raw_hash);
    size += chunk.compressed_size;
  }
  return size;
}

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
