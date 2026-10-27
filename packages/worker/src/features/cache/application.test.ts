import { describe, expect, it } from 'vitest';
import { PublicationApplication } from './application';
import type { CacheIndex, QuotaLedger } from './ports';

describe('publication protocol', () => {
  it('does not compensate an ambiguous quota transport failure', async () => {
    const calls: string[] = [];
    const index: CacheIndex = {
      prepare: async () => {
        calls.push('prepare');
        return {
          operation_id: 'op',
          cache: 'cache',
          delta: 10,
          previous: null,
          record: null,
          status: 'PREPARED',
        };
      },
      commit: async () => {
        calls.push('commit');
        throw new Error('must not commit');
      },
      abort: async () => {
        calls.push('abort');
      },
    };
    const quota: QuotaLedger = {
      reserve: async () => {
        calls.push('reserve');
        throw new Error('quota');
      },
      finalize: async () => {
        calls.push('finalize');
      },
      abort: async () => {
        calls.push('quota-abort');
      },
    };
    await expect(
      new PublicationApplication(index, quota).execute('op', {
        kind: 'delete',
        store_hash: '0'.repeat(32),
      }),
    ).rejects.toThrow('quota');
    expect(calls).toEqual(['prepare', 'reserve']);
  });

  it('reconciles a committed index mutation after a response loss', async () => {
    const calls: string[] = [];
    const index: CacheIndex = {
      prepare: async () => ({
        operation_id: 'op',
        cache: 'cache',
        delta: 10,
        previous: null,
        record: null,
        status: 'COMMITTED',
      }),
      commit: async () => {
        throw new Error('a committed mutation must not be committed twice');
      },
      abort: async () => {
        calls.push('abort');
      },
    };
    const quota: QuotaLedger = {
      reserve: async () => {
        calls.push('reserve');
        return { operation_id: 'op', delta: 10, status: 'RESERVED' };
      },
      finalize: async () => {
        calls.push('finalize');
      },
      abort: async () => {
        calls.push('quota-abort');
      },
    };

    await new PublicationApplication(index, quota).execute('op', {
      kind: 'delete',
      store_hash: '0'.repeat(32),
    });
    expect(calls).toEqual(['reserve', 'finalize']);
  });
});
