import type { CacheConfig } from '../cache/types';
import type { EvictionCacheRef, EvictionResult } from './types';

export interface EvictionPorts {
  liveCaches(): Promise<EvictionCacheRef[]>;
  // Asks the cache's coordinator to start a run if it needs one.
  requestEviction(cache: EvictionCacheRef): Promise<boolean>;
  // Null once the cache is gone.
  cacheConfig(cache: EvictionCacheRef): Promise<CacheConfig | null>;
  accessHistogram(
    cache: EvictionCacheRef,
    prefix: string,
    before: number,
  ): Promise<[hour: number, bytes: number][]>;
  expiredPaths(
    cache: EvictionCacheRef,
    prefix: string,
    before: number,
    after: string | null,
    limit: number,
  ): Promise<{ hashes: string[]; next_after: string | null }>;
  // The bytes freed, or null if the path was kept: it was being published,
  // or was used after `before`.
  evict(
    cache: EvictionCacheRef,
    config: CacheConfig,
    storeHash: string,
    before: number,
    operationId: string,
  ): Promise<number | null>;
  finished(
    cache: EvictionCacheRef,
    generation: number,
    result: EvictionResult,
  ): Promise<void>;
  audit(cache: EvictionCacheRef, result: EvictionResult): Promise<void>;
}

export interface EvictionSteps {
  do<T>(name: string, body: () => Promise<T>): Promise<T>;
}
