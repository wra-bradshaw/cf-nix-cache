import { importJWK, SignJWT } from 'jose';
import type { Grant } from '../../../types';
import { now } from '../../../infrastructure/durable/shared';

export class TokenSigner {
  constructor(private readonly env: Env) {}

  async sign(
    subject: string,
    grants: Grant[],
    expiresAt: number,
  ): Promise<{ jti: string; token: string; issued_at: number }> {
    const issuedAt = now();
    const jti = crypto.randomUUID().replaceAll('-', '');
    const key = await importJWK(
      JSON.parse(this.env.AUTH_PRIVATE_JWK) as JsonWebKey,
      'EdDSA',
    );
    const token = await new SignJWT({ grants })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: 'current' })
      .setIssuer(this.env.TOKEN_ISSUER)
      .setAudience(this.env.TOKEN_AUDIENCE)
      .setSubject(subject)
      .setJti(jti)
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(key);
    return { jti, token, issued_at: issuedAt };
  }
}
