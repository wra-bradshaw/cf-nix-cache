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
  /** Set by the first attempt, so that every retry publishes the same record. */
  published_at: number;
}

export interface UploadRow {
  job_id: string;
  cache: string;
  cache_id: string;
  incarnation: string;
  /** The chunk list, which lets the processor finish or verify the upload. */
  chunks_key: string;
  /**
   * False for a staging upload left from before they were removed. Those can
   * no longer be processed.
   */
  encoded: boolean;
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
