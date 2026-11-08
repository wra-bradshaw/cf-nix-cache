// GENERATED FROM schemas/*.json. Do not edit by hand.
// Regenerate with: pnpm --dir packages/worker generate

// Source: schemas/api.json
export type CfNixCacheAPIContract =
  | CreateCache
  | TokenRequest
  | BootstrapRequest
  | UploadState
  | ConfigureCache
  | Cache
  | MissingPaths
  | TokenResponse
  | TokenSummary
  | AuditEvent
  | GcRunRequest
  | EncodedUploadRequest
  | EncodedUploadBatch
  | EncodedCompleteBatch;
export type Role = 'pull' | 'push' | 'admin';
export type UploadStatus =
  | 'CREATED'
  | 'UPLOADING'
  | 'COMPLETING'
  | 'QUEUED'
  | 'PROCESSING'
  | 'PUBLISHING'
  | 'READY'
  | 'FAILED'
  | 'ABORTED';

export interface CreateCache {
  name: string;
  public?: boolean;
  quota_bytes: number;
  encoding_id?: 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1';
  /**
   * Signing key names of upstream caches. By default, push skips paths signed with these keys.
   *
   * @maxItems 32
   */
  upstream_cache_key_names?: string[];
}
export interface TokenRequest {
  subject: string;
  valid_for_seconds: number;
  /**
   * @minItems 1
   * @maxItems 256
   */
  grants: [Grant, ...Grant[]];
}
export interface Grant {
  cache: string;
  role: Role;
}
export interface BootstrapRequest {
  subject: string;
  valid_for_seconds: number;
  /**
   * @minItems 1
   * @maxItems 256
   */
  grants: [Grant, ...Grant[]];
  secret: string;
}
export interface UploadState {
  id: string;
  status: UploadStatus;
  error: string | null;
}
export interface ConfigureCache {
  public?: boolean;
  /**
   * Evict paths not accessed for this many days during garbage collection. 0 keeps paths indefinitely.
   */
  retention_days?: number;
  /**
   * Signing key names of upstream caches. By default, push skips paths signed with these keys.
   *
   * @maxItems 32
   */
  upstream_cache_key_names?: string[];
}
export interface Cache {
  id: string;
  name: string;
  public: boolean;
  quota_bytes: number;
  logical_bytes: number;
  encoding_id: 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1';
  created_at: number;
  lifecycle: 'CREATING' | 'ACTIVE' | 'DELETING';
  /**
   * Evict paths not accessed for this many days during garbage collection. 0 keeps paths indefinitely.
   */
  retention_days: number;
  /**
   * Signing key names of upstream caches. By default, push skips paths signed with these keys.
   *
   * @maxItems 32
   */
  upstream_cache_key_names: string[];
}
export interface MissingPaths {
  /**
   * @maxItems 100
   */
  store_hashes: string[];
}
export interface TokenResponse {
  id: string;
  token: string;
  expires_at: number;
}
export interface TokenSummary {
  id: string;
  subject: string;
  grants: Grant[];
  issued_at: number;
  expires_at: number;
  revoked: boolean;
}
export interface AuditEvent {
  id: string;
  timestamp: number;
  actor: string;
  action: string;
  resource: string;
  outcome: 'success' | 'accepted' | 'failure';
  metadata: {
    [k: string]: string;
  };
}
export interface GcRunRequest {
  /**
   * Report what would be evicted and deleted without changing anything.
   */
  dry_run?: boolean;
  /**
   * Keep unreferenced objects newer than this. Defaults to one day.
   */
  grace_seconds?: number;
}
/**
 * A NAR the client has already chunked and compressed with encoding_id.
 */
export interface EncodedUploadRequest {
  manifest: Manifest;
  encoding_id: 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1';
  /**
   * @minItems 1
   * @maxItems 16384
   */
  chunks: [EncodedChunk, ...EncodedChunk[]];
}
export interface Manifest {
  cache: string;
  store_hash: string;
  store_path: string;
  nar_hash: string;
  nar_size: number;
  /**
   * @maxItems 1024
   */
  references: string[];
  deriver?: string | null;
  ca?: string | null;
}
export interface EncodedChunk {
  raw_hash: string;
  raw_size: number;
  compressed_hash: string;
  compressed_size: number;
}
export interface EncodedUploadBatch {
  /**
   * @minItems 1
   * @maxItems 64
   */
  uploads: [EncodedUploadRequest, ...EncodedUploadRequest[]];
}
export interface EncodedCompleteBatch {
  /**
   * @minItems 1
   * @maxItems 64
   */
  ids: [string, ...string[]];
}

// Source: schemas/manifest.json
export interface CfNixCacheChunkManifest {
  encoding_id: 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1';
  nar_hash: string;
  nar_size: number;
  file_hash: string;
  file_size: number;
  /**
   * @minItems 1
   */
  chunks: [
    {
      raw_hash: string;
      raw_size: number;
      compressed_hash: string;
      compressed_size: number;
      key: string;
    },
    ...{
      raw_hash: string;
      raw_size: number;
      compressed_hash: string;
      compressed_size: number;
      key: string;
    }[],
  ];
  processing_version: string;
  created_at: number;
}

// Source: schemas/process-job.json
export interface CfNixCacheUploadJob {
  job_id: string;
  nar_hash: string;
  nar_size: number;
  encoding_id: 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1';
  /**
   * The chunk list of a client-encoded upload, whose chunks are already stored.
   */
  chunks_key: string;
}

// Source: schemas/responses.json
export type CfNixCacheAPIResponses =
  | ApiError
  | CacheResponse
  | CachePage
  | UploadStateResponse
  | TokenIssueResponse
  | TokenPageResponse
  | AuditPage
  | MissingPathsResponse
  | GcRunResponse
  | GcStatusResponse
  | CacheUpstreamsResponse
  | EncodedUploadResponse
  | EncodedUploadBatchResponse
  | EncodedCompleteBatchResponse;

export interface ApiError {
  code: string;
  message: string;
  request_id: string;
}
export interface CacheResponse {
  id: string;
  name: string;
  public: boolean;
  quota_bytes: number;
  logical_bytes: number;
  encoding_id: 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1';
  created_at: number;
  /**
   * Signing key names of upstream caches. By default, push skips paths signed with these keys.
   *
   * @maxItems 32
   */
  upstream_cache_key_names: string[];
  /**
   * Evict paths not accessed for this many days during garbage collection. 0 keeps paths indefinitely.
   */
  retention_days: number;
  lifecycle: 'CREATING' | 'ACTIVE' | 'DELETING';
}
export interface CachePage {
  items: CacheResponse[];
  next_cursor: string | null;
}
export interface UploadStateResponse {
  id: string;
  status:
    | 'CREATED'
    | 'UPLOADING'
    | 'COMPLETING'
    | 'QUEUED'
    | 'PROCESSING'
    | 'PUBLISHING'
    | 'READY'
    | 'FAILED'
    | 'ABORTED';
  error: string | null;
}
export interface TokenIssueResponse {
  id: string;
  token: string;
  expires_at: number;
  repeated: boolean;
}
export interface TokenPageResponse {
  items: ResponseTokenSummary[];
  next_cursor: string | null;
}
export interface ResponseTokenSummary {
  id: string;
  subject: string;
  grants: {
    cache: string;
    role: 'pull' | 'push' | 'admin';
  }[];
  issued_at: number;
  expires_at: number;
  revoked: boolean;
}
export interface AuditPage {
  items: {
    id: string;
    timestamp: number;
    actor: string;
    action: string;
    resource: string;
    outcome: 'success' | 'accepted' | 'failure';
    metadata: {
      [k: string]: string;
    };
  }[];
  next_cursor: string | null;
}
export interface MissingPathsResponse {
  missing: string[];
  /**
   * Paths another push is uploading right now. They are not in missing; wait for the upload instead of starting another.
   */
  pending?: {
    store_hash: string;
    upload_id: string;
  }[];
}
export interface GcRunResponse {
  run_id: string;
}
export interface GcStatusResponse {
  active_run?: GcActiveRun;
  last_run?: GcSummary;
}
export interface GcActiveRun {
  run_id: string;
  phase: 'MARK' | 'DRAIN' | 'SWEEP';
  started_at: number;
  dry_run: boolean;
}
export interface GcSummary {
  run_id: string;
  dry_run: boolean;
  outcome: 'success' | 'failed';
  started_at: number;
  finished_at: number;
  evicted_paths: number;
  skipped_paths: number;
  marked_objects: number;
  missing_manifests: number;
  deleted_objects: number;
  deleted_bytes: number;
  error?: string;
}
export interface CacheUpstreamsResponse {
  /**
   * Signing key names of upstream caches. By default, push skips paths signed with these keys.
   *
   * @maxItems 32
   */
  upstream_cache_key_names: string[];
}
export interface EncodedUploadResponse {
  id: string;
  status:
    | 'CREATED'
    | 'UPLOADING'
    | 'COMPLETING'
    | 'QUEUED'
    | 'PROCESSING'
    | 'PUBLISHING'
    | 'READY'
    | 'FAILED'
    | 'ABORTED';
  error: string | null;
  /**
   * The upload belongs to another push of the same NAR. Wait for it; do not send chunks.
   */
  merged: boolean;
  /**
   * Raw hashes of the chunks the server needs. Send each once.
   */
  missing_chunks: string[];
}
export interface EncodedUploadBatchResponse {
  uploads: EncodedUploadResponse[];
}
export interface EncodedCompleteBatchResponse {
  uploads: UploadStateResponse[];
}
