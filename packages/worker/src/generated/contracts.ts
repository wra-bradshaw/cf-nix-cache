// GENERATED FROM schemas/*.json. Do not edit by hand.
// Regenerate with: pnpm --dir packages/worker contracts:generate

// Source: schemas/api.json
export type CfNixCacheAPIContract =
  | CreateCache
  | TokenRequest
  | BootstrapRequest
  | UploadRequest
  | UploadState
  | ConfigureCache
  | Cache
  | MissingPaths
  | TokenResponse
  | TokenSummary
  | AuditEvent
  | CompleteUpload;
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
export interface UploadRequest {
  manifest: Manifest;
  compressed_size: number;
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
export interface UploadState {
  id: string;
  status: UploadStatus;
  error: string | null;
}
export interface ConfigureCache {
  public: boolean;
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
export interface CompleteUpload {
  parts?: {
    part_number: number;
    etag: string;
  }[];
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
export interface CfNixCacheProcessorJob {
  job_id: string;
  staging_key: string;
  nar_hash: string;
  nar_size: number;
  encoding_id: 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1';
}

// Source: schemas/responses.json
export type CfNixCacheAPIResponses =
  | ApiError
  | CacheResponse
  | CachePage
  | UploadStateResponse
  | InitiateUploadResponse
  | TokenIssueResponse
  | TokenPageResponse
  | AuditPage
  | MissingPathsResponse;

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
export interface InitiateUploadResponse {
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
  parts: {
    part_number: number;
    url: string;
  }[];
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
}
