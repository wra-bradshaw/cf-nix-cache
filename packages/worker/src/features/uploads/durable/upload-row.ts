import type {
  ProcessJob,
  UploadManifest,
  UploadState,
  UploadStateResponse,
} from '../types';
import { ENCODING_ID } from '../../cache/types';

export interface ProcessReceipt {
  manifest_key: string;
  deduplicated: boolean;
  published_at: number;
}

export interface UploadRow {
  job_id: string;
  cache: string;
  cache_id: string;
  incarnation: string;
  chunks_key: string;
  state: UploadState;
  manifest: UploadManifest;
  compressed_size: number;
  idempotency_key: string;
  fingerprint: string;
  error: string | null;
  result: ProcessReceipt | null;
}

export const toStateResponse = (row: UploadRow): UploadStateResponse => ({
  id: row.job_id,
  status: row.state,
  error: row.error,
});

export const toProcessJob = (row: UploadRow): ProcessJob => ({
  job_id: row.job_id,
  chunks_key: row.chunks_key,
  nar_hash: row.manifest.nar_hash,
  nar_size: row.manifest.nar_size,
  encoding_id: ENCODING_ID,
});
