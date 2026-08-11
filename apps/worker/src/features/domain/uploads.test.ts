import { describe, expect, it } from 'vitest';
import {
  requestFingerprint,
  transition,
  validateUploadManifest,
} from './uploads';
import { DomainError } from './errors';
import { manifest } from './test-fixtures';

describe('upload invariants', () => {
  it('rejects metadata injection before multipart state exists', () => {
    expect(() =>
      validateUploadManifest(
        { ...manifest, store_path: `${manifest.store_path}\nSig: forged` },
        1,
      ),
    ).toThrow(DomainError);
    expect(() => validateUploadManifest(manifest, 1)).not.toThrow();
  });

  it('has one authoritative upload transition graph', () => {
    expect(() => transition('UPLOADING', 'COMPLETING')).not.toThrow();
    expect(() => transition('READY', 'UPLOADING')).toThrow(DomainError);
    expect(() => transition('PROCESSING', 'ABORTED')).toThrow(DomainError);
    expect(() => transition('PUBLISHING', 'ABORTED')).toThrow(DomainError);
  });

  it('keeps fingerprints stable', () => {
    expect(requestFingerprint({ manifest, compressed_size: 1 })).toBe(
      requestFingerprint({ manifest, compressed_size: 1 }),
    );
  });

  it('uses the real Nix base32 alphabet and UTF-8 byte limits', () => {
    expect(() =>
      validateUploadManifest({ ...manifest, store_hash: 'o'.repeat(32) }, 1),
    ).toThrow(DomainError);
    expect(() =>
      validateUploadManifest(
        {
          ...manifest,
          store_path: `/nix/store/${'0'.repeat(32)}-${'é'.repeat(300)}`,
        },
        1,
      ),
    ).toThrow(DomainError);
    expect(() =>
      validateUploadManifest(
        { ...manifest, references: [`${'0'.repeat(32)}-ok\nforged`] },
        1,
      ),
    ).toThrow(DomainError);
  });
});
