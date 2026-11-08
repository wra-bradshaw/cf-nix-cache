import type {
  CfNixCacheChunkManifest,
  CfNixCacheUploadJob,
  Manifest,
  UploadStateResponse as GeneratedUploadStateResponse,
  UploadStatus,
} from '../../generated/contracts';

export type UploadManifest = Manifest;
export type UploadState = UploadStatus;
export type UploadStateResponse = GeneratedUploadStateResponse;
export type ProcessJob = CfNixCacheUploadJob;
export type ChunkManifest = CfNixCacheChunkManifest;

export interface ChunkRef {
  raw_hash: string;
  raw_size: number;
  compressed_hash: string;
  compressed_size: number;
  key: string;
}

export interface ProcessResult {
  manifest_key: string;
  deduplicated: boolean;
}

export const MAX_METADATA_BYTES = 256 * 1024;
