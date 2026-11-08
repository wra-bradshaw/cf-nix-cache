import { idStub, namedStub } from '../../shared/rpc';
import type { CacheReference } from './types';

export function system(env: Env) {
  return namedStub(env.SYSTEM_CONTROL, 'system');
}

export function coordinator(env: Env, reference: CacheReference) {
  return idStub(env.CACHE_COORDINATOR, reference.coordinator_id);
}

export function indexShard(
  env: Env,
  incarnation: string,
  hashOrPrefix: string,
) {
  return namedStub(
    env.CACHE_INDEX,
    `${incarnation}:${hashOrPrefix.slice(0, 2)}`,
  );
}
