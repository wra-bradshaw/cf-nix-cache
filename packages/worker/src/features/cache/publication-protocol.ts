import type {
  CacheMutation,
  PreparedMutation,
  QuotaReservation,
} from './types';

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

/**
 * Infrastructure-free publication protocol. Durable Object adapters provide
 * the ports; this use case owns the ordering and compensation rules.
 */
export class PublicationProtocol {
  constructor(
    private readonly index: CacheIndex,
    private readonly quota: QuotaLedger,
  ) {}

  async execute(
    operationId: string,
    mutation: CacheMutation,
  ): Promise<PreparedMutation> {
    const prepared = await this.index.prepare(operationId, mutation);
    if (prepared.status === 'ABORTED')
      throw new PublicationError(
        'operation was aborted before publication',
        false,
      );
    try {
      const reservation = await this.quota.reserve(operationId, prepared.delta);
      if (reservation.status === 'ABORTED')
        throw new PublicationError('quota operation was aborted', false);
    } catch (error) {
      // A transport failure is ambiguous: the quota reservation may have
      // committed remotely, so leave the durable prepare in place for a
      // retry/reconciliation rather than issuing a compensating mutation.
      if (error instanceof PublicationError && !error.retryable)
        await this.index.abort(operationId);
      throw error;
    }
    if (prepared.status !== 'COMMITTED') await this.index.commit(operationId);
    await this.quota.finalize(operationId);
    return prepared;
  }
}

export class PublicationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code = 'publication_failed',
    readonly status = retryable ? 503 : 409,
  ) {
    super(message);
  }
}
