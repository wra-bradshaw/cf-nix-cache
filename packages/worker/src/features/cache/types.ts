import type { CacheResponse } from '../../generated/contracts';

export type CacheConfig = CacheResponse;

export interface PathRecord {
  cache: string;
  store_hash: string;
  store_path: string;
  nar_hash: string;
  nar_size: number;
  references: string[];
  deriver?: string | null;
  ca?: string | null;
  manifest_key: string;
  narinfo: string;
  file_hash: string;
  file_size: number;
  last_accessed: number;
  created_at: number;
}

export type CacheMutation =
  | { kind: 'upsert'; record: PathRecord }
  | { kind: 'delete'; store_hash: string }
  | { kind: 'clear' };

export interface PreparedMutation {
  operation_id: string;
  cache: string;
  store_hash?: string;
  delta: number;
  previous: PathRecord | null;
  record: PathRecord | null;
  status: 'PREPARED' | 'COMMITTED' | 'ABORTED';
}

export interface QuotaReservation {
  operation_id: string;
  delta: number;
  status: 'RESERVED' | 'FINALIZED' | 'ABORTED';
}

export interface CacheReference {
  id: string;
  name: string;
  incarnation: string;
  coordinator_id: string;
  /** Catalogue lifecycle; SystemControl may lead the coordinator by a step. */
  lifecycle: CacheConfig['lifecycle'];
}

export type CacheState = CacheConfig & { reference: CacheReference };

export interface CacheWorkflowJob {
  cache: string;
  cache_id: string;
  incarnation: string;
  coordinator_id: string;
  operation_id: string;
}

/** Most clients of a cache also use cache.nixos.org. */
export const DEFAULT_UPSTREAM_CACHE_KEY_NAMES = ['cache.nixos.org-1'];

export const ENCODING_ID = 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1';
