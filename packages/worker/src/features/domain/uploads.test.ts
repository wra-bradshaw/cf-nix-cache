import { describe, expect, it } from 'vitest';
import { requestFingerprint, validateUploadManifest } from './uploads';
import { DomainError, parseJsonSchema } from './errors';
import { UploadRequestSchema } from './schemas';
import { manifest } from './test-fixtures';

describe('upload invariants', () => {
  it('rejects metadata injection before multipart state exists', () => {
    expect(() =>
      validateUploadManifest({
        ...manifest,
        store_path: `${manifest.store_path}\nSig: forged`,
      }),
    ).toThrow(DomainError);
    expect(() => validateUploadManifest(manifest)).not.toThrow();
  });

  it('ties the store path to the declared store hash', () => {
    expect(() =>
      validateUploadManifest({
        ...manifest,
        store_path: `/nix/store/${'1'.repeat(32)}-hello`,
      }),
    ).toThrow('store path does not match the declared store hash');
    expect(() =>
      validateUploadManifest({
        ...manifest,
        store_path: `${manifest.store_path}/bin`,
      }),
    ).toThrow('store path does not match the declared store hash');
  });

  it('keeps fingerprints stable', () => {
    expect(requestFingerprint({ manifest, compressed_size: 1 })).toBe(
      requestFingerprint({ manifest, compressed_size: 1 }),
    );
  });

  it('uses the real Nix base32 alphabet and UTF-8 byte limits', () => {
    expect(() =>
      parseJsonSchema(UploadRequestSchema, {
        manifest: { ...manifest, store_hash: 'o'.repeat(32) },
        compressed_size: 1,
      }),
    ).toThrow(DomainError);
    expect(() =>
      validateUploadManifest({
        ...manifest,
        store_path: `/nix/store/${'0'.repeat(32)}-${'é'.repeat(300)}`,
      }),
    ).toThrow(DomainError);
    expect(() =>
      validateUploadManifest({
        ...manifest,
        references: [`${'0'.repeat(32)}-ok\nforged`],
      }),
    ).toThrow(DomainError);
  });
});
