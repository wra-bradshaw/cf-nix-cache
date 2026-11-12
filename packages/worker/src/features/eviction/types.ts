import type { EvictionResult as GeneratedResult } from '../../generated/contracts';
import type { CacheReference } from '../cache/types';

export type EvictionResult = GeneratedResult;

export interface EvictionCacheRef {
  id: string;
  name: string;
  incarnation: string;
  coordinator_id: string;
}

export interface ListedCache extends EvictionCacheRef {
  lifecycle: CacheReference['lifecycle'];
}

// A run for one cache. The scheduled daily instance has no payload and only
// asks every cache whether it needs a run.
export interface EvictionJob {
  cache: EvictionCacheRef;
  generation: number;
}
