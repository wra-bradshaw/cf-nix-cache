import { DomainError } from '../../shared/errors';
import { authenticate } from '../auth/authentication';
import type { Role } from '../auth/types';
import type { CacheState } from './types';

/** The error for a request against a cache that is not ACTIVE, if any. */
export function lifecycleFailure(lifecycle: string): DomainError | null {
  if (lifecycle === 'ACTIVE') return null;
  return lifecycle === 'DELETING'
    ? new DomainError('cache_deleting', 'cache is being deleted', 410)
    : new DomainError('cache_unavailable', 'cache is not active', 503);
}

/** Rejects requests against a cache that is not ACTIVE. */
export function assertActive(cache: CacheState): void {
  const blocked = lifecycleFailure(cache.lifecycle);
  if (blocked) throw blocked;
}

export async function authFor(
  request: Request,
  env: Env,
  cache: CacheState,
  required: Role,
): Promise<{ sub: string }> {
  assertActive(cache);
  if (required === 'pull' && cache.public) return { sub: 'anonymous' };
  return authenticate(request, env, cache.name, required);
}
