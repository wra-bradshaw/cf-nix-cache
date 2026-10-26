import type { Grant, PathRecord, UploadManifest } from '../../types';
import { MAX_METADATA_BYTES } from '../../types';
import { GrantSchema } from './schemas';
import { DomainError } from './errors';
import {
  hasControlCharacters,
  STORE_HASH_PATTERN,
  utf8Bytes,
} from './identifiers';

const PATH_NAME = new RegExp(`^${STORE_HASH_PATTERN}-.{1,479}$`, 'u');

function validPathName(value: string): boolean {
  return (
    PATH_NAME.test(value) &&
    utf8Bytes(value) <= 512 &&
    !hasControlCharacters(value, true)
  );
}

function invalid(message: string): DomainError {
  return new DomainError('validation_failed', message, 422);
}

export function validateGrant(grant: unknown): grant is Grant {
  return Boolean(GrantSchema.validate(grant));
}

/**
 * Upload metadata rules that UploadRequestSchema cannot express: UTF-8 byte
 * limits, control characters, the store path/hash relation, and the total
 * metadata size. The manifest must already match the schema.
 */
export function validateUploadManifest(manifest: UploadManifest): void {
  if (
    utf8Bytes(manifest.store_path) > 512 ||
    hasControlCharacters(manifest.store_path)
  )
    throw invalid('store metadata contains invalid characters');
  if (
    manifest.store_path.split('/').length !== 4 ||
    !manifest.store_path.startsWith(`/nix/store/${manifest.store_hash}-`)
  )
    throw invalid('store path does not match the declared store hash');
  if (utf8Bytes(JSON.stringify(manifest)) > MAX_METADATA_BYTES)
    throw invalid('upload metadata is too large');
  if (
    manifest.references.some((reference) => !validPathName(reference)) ||
    (manifest.deriver != null && !validPathName(manifest.deriver)) ||
    (manifest.ca != null &&
      (utf8Bytes(manifest.ca) > 512 || hasControlCharacters(manifest.ca)))
  )
    throw invalid('store metadata contains invalid characters');
}

export function requestFingerprint(input: {
  manifest: UploadManifest;
  compressed_size: number;
}): string {
  return JSON.stringify({
    compressed_size: input.compressed_size,
    manifest: input.manifest,
  });
}

export function partsFor(size: number, partSize: number): number {
  return Math.ceil(size / partSize);
}

export function deltaFor(
  next: PathRecord | null,
  previous: PathRecord | null,
): number {
  return (next?.file_size ?? 0) - (previous?.file_size ?? 0);
}
