import type {
  GcActiveRun as GeneratedActiveRun,
  GcRunRequest,
  GcSummary as GeneratedSummary,
} from '../../generated/contracts';

export type GcActiveRun = GeneratedActiveRun;
export type GcPhase = GcActiveRun['phase'];
export type GcSummary = GeneratedSummary;
/** Empty for a scheduled run. */
export type GcJob = GcRunRequest;
