import type {
  Grant,
  PathRecord,
  UploadManifest,
  UploadState,
} from '../../types';
import { MAX_METADATA_BYTES } from '../../types';
import { GrantSchema, ManifestSchema, UploadRequestSchema } from './schemas';
import { DomainError, parseJsonSchema } from './errors';
import {
  assertCacheName,
  assertStoreHash,
  hasControlCharacters,
  utf8Bytes,
} from './identifiers';

const NIX_BASE32 = '0123456789abcdfghijklmnpqrsvwxyz';

function assertSafeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(
      'invalid_number',
      `${label} must be a non-negative safe integer`,
      422,
    );
  }
}

function validPathName(value: string): boolean {
  return (
    new RegExp(`^[${NIX_BASE32}]{32}-.{1,479}$`, 'u').test(value) &&
    utf8Bytes(value) <= 512 &&
    !hasControlCharacters(value, true)
  );
}

export function validateGrant(grant: unknown): grant is Grant {
  return Boolean(GrantSchema.validate(grant));
}

export function validateUploadManifest(
  manifest: UploadManifest,
  compressedSize: number,
): void {
  const validManifest = parseJsonSchema(ManifestSchema, manifest);
  parseJsonSchema(UploadRequestSchema, {
    manifest: validManifest,
    compressed_size: compressedSize,
  });
  assertSafeInteger(compressedSize, 'compressed_size');
  assertCacheName(validManifest.cache);
  assertStoreHash(validManifest.store_hash);
  if (
    utf8Bytes(validManifest.store_path) > 512 ||
    hasControlCharacters(validManifest.store_path)
  ) {
    throw new DomainError(
      'validation_failed',
      'store metadata contains invalid characters',
      422,
    );
  }
  const basename = validManifest.store_path.split('/').at(-1) ?? '';
  if (
    !validManifest.store_path.startsWith('/nix/store/') ||
    validManifest.store_path.split('/').length !== 4 ||
    !basename.startsWith(`${validManifest.store_hash}-`) ||
    basename.length <= validManifest.store_hash.length + 1
  ) {
    throw new DomainError(
      'validation_failed',
      'store path does not match the declared store hash',
      422,
    );
  }
  if (
    new TextEncoder().encode(JSON.stringify(validManifest)).byteLength >
    MAX_METADATA_BYTES
  ) {
    throw new DomainError(
      'validation_failed',
      'upload metadata is too large',
      422,
    );
  }
  if (
    validManifest.references.some((reference) => !validPathName(reference)) ||
    (validManifest.deriver != null && !validPathName(validManifest.deriver)) ||
    (validManifest.ca != null &&
      (utf8Bytes(validManifest.ca) > 512 ||
        hasControlCharacters(validManifest.ca)))
  ) {
    throw new DomainError(
      'validation_failed',
      'store metadata contains invalid characters',
      422,
    );
  }
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

export function transition(from: UploadState, to: UploadState): void {
  if (from === to) return;
  const allowed: Record<UploadState, UploadState[]> = {
    CREATED: ['UPLOADING', 'ABORTED', 'FAILED'],
    UPLOADING: ['COMPLETING', 'ABORTED', 'FAILED'],
    COMPLETING: ['QUEUED', 'ABORTED', 'FAILED'],
    QUEUED: ['PROCESSING', 'ABORTED', 'FAILED'],
    PROCESSING: ['PUBLISHING', 'FAILED'],
    PUBLISHING: ['READY', 'FAILED'],
    READY: [],
    FAILED: [],
    ABORTED: [],
  };
  if (!allowed[from].includes(to))
    throw new DomainError(
      'invalid_transition',
      `invalid upload transition from ${from} to ${to}`,
      409,
    );
}

export function deltaFor(
  next: PathRecord | null,
  previous: PathRecord | null,
): number {
  return (next?.file_size ?? 0) - (previous?.file_size ?? 0);
}
