import { importJWK, SignJWT } from 'jose';
import type { Grant } from '../types';
import { now } from '../../../shared/clock';

export interface TokenIdentity {
  jti: string;
  issued_at: number;
}

export class TokenSigner {
  constructor(private readonly env: Env) {}

  async sign(
    subject: string,
    grants: Grant[],
    expiresAt: number,
  ): Promise<TokenIdentity & { token: string }> {
    const identity = {
      jti: crypto.randomUUID().replaceAll('-', ''),
      issued_at: now(),
    };
    return {
      ...identity,
      token: await this.signFor(identity, subject, grants, expiresAt),
    };
  }

  /** Reproduces an issued token from its stored metadata. */
  async signFor(
    { jti, issued_at: issuedAt }: TokenIdentity,
    subject: string,
    grants: Grant[],
    expiresAt: number,
  ): Promise<string> {
    const key = await importJWK(
      JSON.parse(this.env.AUTH_PRIVATE_JWK) as JsonWebKey,
      'EdDSA',
    );
    return new SignJWT({ grants })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: 'current' })
      .setIssuer(this.env.TOKEN_ISSUER)
      .setAudience(this.env.TOKEN_AUDIENCE)
      .setSubject(subject)
      .setJti(jti)
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(key);
  }
}
