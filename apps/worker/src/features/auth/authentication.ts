import type { Role, TokenClaims } from '../../types';
import { namedStub } from '../../rpc';
import { permitsAny, permitsCache, permitsGlobal } from './authorization';
import { tokenFromRequest } from './credentials';
import { AuthError } from './errors';
import { verifySignature } from './jwt';

const TOKEN_STATUS_CACHE_TTL = 5;

async function verifiedClaims(
  request: Request,
  env: Env,
): Promise<TokenClaims> {
  const token = tokenFromRequest(request);
  if (!token)
    throw new AuthError('missing_token', 'authentication is required');
  try {
    return await verifySignature(token, env);
  } catch (error) {
    throw new AuthError(
      'invalid_token',
      error instanceof Error ? error.message : 'invalid token',
    );
  }
}

async function assertActive(env: Env, claims: TokenClaims): Promise<void> {
  const key = new Request(
    `https://token-status.invalid/${encodeURIComponent(claims.iss)}/${encodeURIComponent(claims.jti)}?exp=${claims.exp}`,
  );
  try {
    const cached = await caches.default.match(key);
    if (cached) return;
  } catch {
    // Cache API availability is runtime-dependent; the catalog remains the
    // authoritative fallback.
  }

  const result = await namedStub(env.TOKEN_CATALOG, 'catalog').check({
    jti: claims.jti,
    exp: claims.exp,
  });
  if (!result.ok || !result.value.active)
    throw new AuthError('revoked_token', 'token is revoked or unknown');

  try {
    void caches.default
      .put(
        key,
        Response.json(
          { active: true },
          {
            headers: {
              'cache-control': `public, max-age=${TOKEN_STATUS_CACHE_TTL}`,
            },
          },
        ),
      )
      .catch(() => undefined);
  } catch {
    // Best-effort acceleration only; never make authentication depend on it.
  }
}

export async function authenticateAny(
  request: Request,
  env: Env,
  required: Role,
): Promise<TokenClaims> {
  const claims = await verifiedClaims(request, env);
  if (!permitsAny(claims, required))
    throw new AuthError(
      'forbidden',
      'token does not grant the requested capability',
    );
  await assertActive(env, claims);
  return claims;
}

export async function authenticate(
  request: Request,
  env: Env,
  cache: string,
  required: Role,
): Promise<TokenClaims> {
  const claims = await verifiedClaims(request, env);
  if (!permitsCache(claims, cache, required))
    throw new AuthError(
      'forbidden',
      'token does not grant the requested capability',
    );
  await assertActive(env, claims);
  return claims;
}

export async function authenticateGlobal(
  request: Request,
  env: Env,
  required: Role,
): Promise<TokenClaims> {
  const claims = await verifiedClaims(request, env);
  if (!permitsGlobal(claims, required))
    throw new AuthError(
      'forbidden',
      'token does not grant the requested global capability',
    );
  await assertActive(env, claims);
  return claims;
}
