import { describe, expect, it } from 'vitest';
import { validateUploadManifest } from './manifest';
import { DomainError } from '../../shared/errors';
import {
  EncodedUploadRequestSchema,
  parseJsonSchema,
} from '../../shared/schemas';
import { manifest } from '../../shared/test-fixtures';

const chunk = {
  raw_hash: `sha256:${'0'.repeat(52)}`,
  raw_size: 1,
  compressed_hash: `sha256:${'0'.repeat(52)}`,
  compressed_size: 1,
};

describe('upload invariants', () => {
  it('rejects metadata injection before upload state exists', () => {
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

  it('uses the real Nix base32 alphabet and UTF-8 byte limits', () => {
    expect(() =>
      parseJsonSchema(EncodedUploadRequestSchema, {
        manifest: { ...manifest, store_hash: 'o'.repeat(32) },
        encoding_id: 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1',
        chunks: [chunk],
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
