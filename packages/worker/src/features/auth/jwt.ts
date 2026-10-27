import { createLocalJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Grant, TokenClaims } from '../../types';
import { validateGrant } from '../domain/uploads';

function claimsFromPayload(payload: JWTPayload): TokenClaims {
  if (
    typeof payload.iss !== 'string' ||
    typeof payload.aud !== 'string' ||
    typeof payload.sub !== 'string' ||
    typeof payload.jti !== 'string' ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    !Array.isArray(payload.grants) ||
    !payload.grants.every(validateGrant)
  ) {
    throw new Error('token claims do not match the capability contract');
  }
  return {
    iss: payload.iss,
    aud: payload.aud,
    sub: payload.sub,
    jti: payload.jti,
    iat: payload.iat,
    nbf: typeof payload.nbf === 'number' ? payload.nbf : undefined,
    exp: payload.exp,
    grants: payload.grants as Grant[],
  };
}

export async function verifySignature(
  token: string,
  env: Env,
): Promise<TokenClaims> {
  const configured = JSON.parse(env.AUTH_PUBLIC_JWKS) as Array<{
    kid: string;
    jwk: JsonWebKey;
  }>;
  const keySet = createLocalJWKSet({
    keys: configured.map(({ kid, jwk }) => ({ ...jwk, kid })),
  });
  const verified = await jwtVerify(token, keySet, {
    issuer: env.TOKEN_ISSUER,
    audience: env.TOKEN_AUDIENCE,
    algorithms: ['EdDSA'],
    typ: 'JWT',
  });
  return claimsFromPayload(verified.payload);
}
