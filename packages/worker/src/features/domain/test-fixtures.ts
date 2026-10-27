import type { UploadManifest } from '../../types';

export const manifest: UploadManifest = {
  cache: 'cache',
  store_hash: '0'.repeat(32),
  store_path: `/nix/store/${'0'.repeat(32)}-hello`,
  nar_hash: `sha256:${'0'.repeat(52)}`,
  nar_size: 1,
  references: [],
  deriver: null,
  ca: null,
};
