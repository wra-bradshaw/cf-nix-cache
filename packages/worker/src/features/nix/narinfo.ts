import type { ChunkManifest, PathRecord } from '../../types';

const encoder = new TextEncoder();

function standardBase64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

export async function renderNarInfo(
  env: Env,
  record: PathRecord,
  manifest: ChunkManifest,
): Promise<string> {
  const references = record.references.join(' ');
  const fingerprint = `1;${record.store_path};${record.nar_hash};${record.nar_size};${record.references.map((reference) => `/nix/store/${reference}`).join(',')}`;
  const key = await crypto.subtle.importKey(
    'jwk',
    JSON.parse(env.NIX_PRIVATE_JWK) as JsonWebKey,
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    key,
    encoder.encode(fingerprint),
  );
  const lines = [
    `StorePath: ${record.store_path}`,
    `URL: nar/${record.store_hash}.nar.zst`,
    'Compression: zstd',
    `FileHash: ${manifest.file_hash}`,
    `FileSize: ${manifest.file_size}`,
    `NarHash: ${record.nar_hash}`,
    `NarSize: ${record.nar_size}`,
    `References: ${references}`,
    `Sig: ${env.NIX_SIGNING_KEY_NAME}:${standardBase64(signature)}`,
  ];
  if (record.deriver) lines.push(`Deriver: ${record.deriver}`);
  if (record.ca) lines.push(`CA: ${record.ca}`);
  return `${lines.join('\n')}\n`;
}
