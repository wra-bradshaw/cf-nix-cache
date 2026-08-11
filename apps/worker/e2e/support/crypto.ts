import { createHash, generateKeyPairSync } from 'node:crypto';

export type KeyMaterial = {
  readonly privateJwk: JsonWebKey;
  readonly publicJwk: JsonWebKey & { readonly x: string };
};

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function nixPublicKey(
  name: string,
  jwk: JsonWebKey & { readonly x: string },
): string {
  return `${name}:${Buffer.from(jwk.x, 'base64url').toString('base64')}`;
}

export function keyMaterial(): KeyMaterial {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateJwk: pair.privateKey.export({ format: 'jwk' }) as JsonWebKey,
    publicJwk: pair.publicKey.export({ format: 'jwk' }) as JsonWebKey & {
      readonly x: string;
    },
  };
}
