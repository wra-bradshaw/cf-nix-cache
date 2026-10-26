import type {
  ProcessJob,
  UploadManifest,
  UploadState,
  UploadStateResponse,
} from '../../../types';
import { ENCODING_ID } from '../../../types';

export interface ProcessReceipt {
  manifest_key: string;
  deduplicated: boolean;
}

export interface UploadRow {
  job_id: string;
  cache: string;
  cache_id: string;
  incarnation: string;
  staging_key: string;
  upload_id: string | null;
  state: UploadState;
  manifest: UploadManifest;
  compressed_size: number;
  idempotency_key: string;
  fingerprint: string;
  parts: Record<string, string>;
  error: string | null;
  result: ProcessReceipt | null;
}

export const state = (row: UploadRow): UploadStateResponse => ({
  id: row.job_id,
  status: row.state,
  error: row.error,
});

export const processJob = (row: UploadRow): ProcessJob => ({
  job_id: row.job_id,
  staging_key: row.staging_key,
  nar_hash: row.manifest.nar_hash,
  nar_size: row.manifest.nar_size,
  encoding_id: ENCODING_ID,
});
