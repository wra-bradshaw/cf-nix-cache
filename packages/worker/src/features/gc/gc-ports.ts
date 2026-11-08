import type { GcSummary } from './types';

export interface GcCache {
  name: string;
  incarnation: string;
  retention_days: number;
}

export interface GcLedgerPort {
  begin(input: { dry_run: boolean }): Promise<boolean>;
  addMarks(keys: string[]): Promise<void>;
  pendingManifests(limit: number): Promise<string[]>;
  expand(manifests: { key: string; chunk_keys: string[] }[]): Promise<void>;
  addCandidates(objects: { key: string; size: number }[]): Promise<void>;
  candidateTotals(): Promise<{
    objects: number;
    bytes: number;
    marked: number;
  }>;
  closeGate(): Promise<boolean>;
  nextDeletions(limit: number): Promise<{ key: string; size: number }[]>;
  markDeleted(keys: string[]): Promise<void>;
  finish(summary: GcSummary): Promise<void>;
}

export interface GcCatalogPort {
  liveCaches(): Promise<GcCache[]>;
  manifestKeys(
    cache: GcCache,
    prefix: string,
    after: string | null,
    limit: number,
  ): Promise<{ keys: string[]; next_after: string | null }>;
  expiredPaths(
    cache: GcCache,
    prefix: string,
    before: number,
    after: string | null,
    limit: number,
  ): Promise<{ hashes: string[]; next_after: string | null }>;
  evict(
    cache: GcCache,
    storeHash: string,
    operationId: string,
  ): Promise<boolean>;
  auditEviction(cache: GcCache, runId: string, paths: number): Promise<void>;
}

export interface GcObjectsPort {
  manifestChunks(key: string): Promise<string[] | null>;
  list(
    prefix: string,
    cursor: string | null,
    limit: number,
  ): Promise<{
    objects: { key: string; size: number; uploaded: number }[];
    cursor: string | null;
  }>;
  delete(keys: string[]): Promise<void>;
}

export interface GcSteps {
  do<T>(name: string, body: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: '30 seconds'): Promise<void>;
}
