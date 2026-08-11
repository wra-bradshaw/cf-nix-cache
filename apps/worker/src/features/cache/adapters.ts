import { PublicationApplication, PublicationError } from './application';
import type { CacheIndex, QuotaLedger } from './ports';
import type {
  CacheMutation,
  CacheState,
  PreparedMutation,
  QuotaReservation,
} from '../../types';
import { idStub } from '../../rpc';
import { unwrapPublication } from './adapters-rpc';

class DurableCacheIndexAdapter implements CacheIndex {
  constructor(
    private readonly stub: ReturnType<NonNullable<Env['CACHE_INDEX']>['get']>,
    private readonly cache: string,
  ) {}

  async prepare(
    operationId: string,
    mutation: CacheMutation,
  ): Promise<PreparedMutation> {
    if (mutation.kind === 'clear')
      throw new PublicationError('clear is not a path publication', false);
    const request =
      mutation.kind === 'upsert'
        ? { kind: 'upsert' as const, record: mutation.record }
        : { kind: 'delete' as const, store_hash: mutation.store_hash };
    return {
      ...unwrapPublication(
        await this.stub.prepare({
          operation_id: operationId,
          mutation: request,
        }),
        this.cache,
      ),
      cache: this.cache,
    };
  }

  async commit(operationId: string): Promise<PreparedMutation> {
    return {
      ...unwrapPublication(await this.stub.commit(operationId), this.cache),
      cache: this.cache,
    };
  }

  async abort(operationId: string): Promise<void> {
    unwrapPublication(await this.stub.abort(operationId), this.cache);
  }
}

class DurableQuotaLedgerAdapter implements QuotaLedger {
  constructor(
    private readonly stub: ReturnType<
      NonNullable<Env['CACHE_COORDINATOR']>['get']
    >,
  ) {}

  async reserve(operationId: string, delta: number): Promise<QuotaReservation> {
    return unwrapPublication(
      await this.stub.reserve({ operation_id: operationId, delta }),
      'quota',
    );
  }

  async finalize(operationId: string): Promise<void> {
    unwrapPublication(
      await this.stub.finalize({ operation_id: operationId }),
      'quota',
    );
  }

  async abort(operationId: string): Promise<void> {
    unwrapPublication(
      await this.stub.abort({ operation_id: operationId }),
      'quota',
    );
  }
}

export function publicationFor(
  env: Env,
  cache: CacheState,
  storeHash: string,
): PublicationApplication {
  const index = idStub(
    env.CACHE_INDEX,
    env.CACHE_INDEX!.idFromName(
      `${cache.reference.incarnation}:${storeHash.slice(0, 2)}`,
    ),
  );
  const quota = idStub(env.CACHE_COORDINATOR, cache.reference.coordinator_id);
  return new PublicationApplication(
    new DurableCacheIndexAdapter(index, cache.name),
    new DurableQuotaLedgerAdapter(quota),
  );
}
