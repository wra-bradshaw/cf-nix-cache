import type {
  CacheMutation,
  PreparedMutation,
  QuotaReservation,
} from './types';

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
    if (prepared.status === 'ABORTED') {
      // A retry after the index refused a commit: release the reservation in
      // case the first attempt could not.
      await this.quota.abort(operationId);
      throw new PublicationError(
        'operation was aborted before publication',
        false,
      );
    }
    try {
      const reservation = await this.quota.reserve(operationId, prepared.delta);
      if (reservation.status === 'ABORTED')
        throw new PublicationError('quota operation was aborted', false);
    } catch (error) {
      if (error instanceof PublicationError && !error.retryable)
        await this.index.abort(operationId);
      throw error;
    }
    if (prepared.status !== 'COMMITTED')
      try {
        await this.index.commit(operationId);
      } catch (error) {
        // The index refused the mutation for good (an eviction of a path that
        // was just used), so release the reservation instead of leaving it.
        if (error instanceof PublicationError && !error.retryable)
          await this.quota.abort(operationId);
        throw error;
      }
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
