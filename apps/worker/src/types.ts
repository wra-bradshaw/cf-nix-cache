import type {
  AuditEvent as GeneratedAuditEvent,
  CacheResponse as GeneratedCacheResponse,
  CfNixCacheChunkManifest,
  CfNixCacheProcessorJob,
  CompleteUpload,
  InitiateUploadResponse as GeneratedInitiateUploadResponse,
  Grant as GeneratedGrant,
  Manifest as GeneratedManifest,
  ResponseTokenSummary as GeneratedTokenSummary,
  Role as GeneratedRole,
  UploadStatus,
  UploadStateResponse as GeneratedUploadStateResponse,
} from './generated/contracts';

export type Role = GeneratedRole;

export type UploadState = UploadStatus;

export type Grant = GeneratedGrant;

export interface TokenClaims {
  iss: string;
  aud: string;
  sub: string;
  jti: string;
  iat: number;
  nbf?: number;
  exp: number;
  grants: Grant[];
}

export type CacheConfig = GeneratedCacheResponse;

export type UploadManifest = GeneratedManifest;
export type ChunkManifest = CfNixCacheChunkManifest;
export type CompleteUploadRequest = CompleteUpload;

export interface ChunkRef {
  raw_hash: string;
  raw_size: number;
  compressed_hash: string;
  compressed_size: number;
  key: string;
}

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

export type ProcessJob = CfNixCacheProcessorJob;

export type UploadStateResponse = GeneratedUploadStateResponse;

export type InitiateUploadResponse = GeneratedInitiateUploadResponse;

export interface PageResponse<T> {
  items: T[];
  next_cursor: string | null;
}

export type TokenSummary = GeneratedTokenSummary;

export type AuditEvent = GeneratedAuditEvent;

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

export interface ProcessResult {
  manifest_key: string;
  manifest: ChunkManifest;
  deduplicated: boolean;
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

declare global {
  interface Env {
    AUTH_PRIVATE_JWK: string;
    AUTH_PUBLIC_JWKS: string;
    NIX_PRIVATE_JWK: string;
    BOOTSTRAP_SECRET_HASH: string;
  }
}

export const ENCODING_ID = 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1';
export const MULTIPART_PART_SIZE = 64 * 1024 * 1024;
export const MAX_METADATA_BYTES = 256 * 1024;
