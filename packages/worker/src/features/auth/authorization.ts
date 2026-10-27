import type { Grant, Role, TokenClaims } from '../../types';

function permits(grant: Role, required: Role): boolean {
  return (
    grant === 'admin' ||
    grant === required ||
    (grant === 'push' && required === 'pull')
  );
}

export function permitsCache(
  claims: TokenClaims,
  cache: string,
  required: Role,
): boolean {
  return claims.grants.some(
    (grant) =>
      (grant.cache === cache || grant.cache === '*') &&
      permits(grant.role, required),
  );
}

/** Every delegated grant must be covered by one parent admin grant. */
export function canDelegate(
  parent: TokenClaims,
  grants: Grant[],
  expiresAt: number,
): boolean {
  return (
    expiresAt <= parent.exp &&
    grants.length > 0 &&
    grants.every((child) =>
      parent.grants.some(
        (grant) =>
          grant.role === 'admin' &&
          (grant.cache === '*' || grant.cache === child.cache),
      ),
    )
  );
}

export function permitsAny(claims: TokenClaims, required: Role): boolean {
  return claims.grants.some((grant) => permits(grant.role, required));
}

/** Global control-plane operations require an explicit wildcard grant. */
export function permitsGlobal(claims: TokenClaims, required: Role): boolean {
  return claims.grants.some(
    (grant) => grant.cache === '*' && permits(grant.role, required),
  );
}
