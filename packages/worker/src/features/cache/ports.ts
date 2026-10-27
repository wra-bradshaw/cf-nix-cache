import type {
  CacheMutation,
  PreparedMutation,
  QuotaReservation,
} from '../../types';

/** The only application boundary needed by production publication paths. */
export interface CacheIndex {
  prepare(
    operationId: string,
    mutation: CacheMutation,
  ): Promise<PreparedMutation>;
  commit(operationId: string): Promise<PreparedMutation>;
  abort(operationId: string): Promise<void>;
}

export interface QuotaLedger {
  reserve(operationId: string, delta: number): Promise<QuotaReservation>;
  finalize(operationId: string): Promise<void>;
  abort(operationId: string): Promise<void>;
}
