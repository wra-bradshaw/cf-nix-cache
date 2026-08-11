import type { CacheIndex, QuotaLedger } from './ports';
import type { CacheMutation, PreparedMutation } from '../../types';

/**
 * Infrastructure-free publication protocol. Durable Object adapters provide
 * the ports; this use case owns the ordering and compensation rules.
 */
export class PublicationApplication {
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
  ) {
    super(message);
  }
}
