import { describe, expect, it } from 'vitest';
import type { CacheState } from './types';
import { publicationFor } from './publication-adapters';
import { PublicationError } from './publication-protocol';

const cache = {
  name: 'cache',
  reference: { incarnation: 'i', coordinator_id: '0'.repeat(64) },
} as CacheState;

function rejectingPrepare(code: string, status: number) {
  return publicationFor(
    {
      CACHE_INDEX: {
        getByName: () => ({
          prepare: async () => ({
            ok: false,
            error: { code, message: 'rejected', status },
          }),
        }),
      },
      CACHE_COORDINATOR: { idFromString: (id: string) => id, get: () => ({}) },
    } as unknown as Env,
    cache,
    '0'.repeat(32),
  ).execute('op', { kind: 'delete', store_hash: '0'.repeat(32) });
}

describe('publication failure classification', () => {
  it.each([
    ['mutation_in_progress', 409, true],
    ['unavailable', 503, true],
    ['cache_deleting', 410, false],
    ['quota_exceeded', 409, false],
  ])('%s (%i) retryable: %s', async (code, status, retryable) => {
    const error = await rejectingPrepare(code, status).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(PublicationError);
    expect(error).toMatchObject({ code, status, retryable });
  });
});
