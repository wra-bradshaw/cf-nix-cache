import { exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { TokenSigner } from './signer';

describe('token signer', () => {
  it('reproduces an issued token from its metadata', async () => {
    const { privateKey } = await generateKeyPair('EdDSA', {
      extractable: true,
    });
    const signer = new TokenSigner({
      AUTH_PRIVATE_JWK: JSON.stringify(await exportJWK(privateKey)),
      TOKEN_ISSUER: 'issuer',
      TOKEN_AUDIENCE: 'audience',
    } as unknown as Env);
    const grants = [{ cache: '*', role: 'admin' as const }];
    const issued = await signer.sign('admin', grants, 4_000_000_000);
    await expect(
      signer.signFor(issued, 'admin', grants, 4_000_000_000),
    ).resolves.toBe(issued.token);
  });
});
