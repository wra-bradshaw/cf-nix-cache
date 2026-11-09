import { describe, expect, it } from 'vitest';
import { PublicationError, PublicationProtocol } from './publication-protocol';
import type { CacheIndex, QuotaLedger } from './publication-protocol';

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
      new PublicationProtocol(index, quota).execute('op', {
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

    await new PublicationProtocol(index, quota).execute('op', {
      kind: 'delete',
      store_hash: '0'.repeat(32),
    });
    expect(calls).toEqual(['reserve', 'finalize']);
  });

  it('releases the reservation when the index refuses the commit', async () => {
    const calls: string[] = [];
    const index: CacheIndex = {
      prepare: async () => ({
        operation_id: 'op',
        cache: 'cache',
        delta: -10,
        previous: null,
        record: null,
        status: 'PREPARED',
      }),
      commit: async () => {
        calls.push('commit');
        throw new PublicationError('path in use', false, 'path_in_use');
      },
      abort: async () => {
        calls.push('abort');
      },
    };
    const quota: QuotaLedger = {
      reserve: async () => {
        calls.push('reserve');
        return { operation_id: 'op', delta: -10, status: 'RESERVED' };
      },
      finalize: async () => {
        calls.push('finalize');
      },
      abort: async () => {
        calls.push('quota-abort');
      },
    };
    await expect(
      new PublicationProtocol(index, quota).execute('op', {
        kind: 'delete',
        store_hash: '0'.repeat(32),
      }),
    ).rejects.toThrow('path in use');
    expect(calls).toEqual(['reserve', 'commit', 'quota-abort']);
  });

  it('releases the reservation again when retrying an aborted operation', async () => {
    const calls: string[] = [];
    const index: CacheIndex = {
      prepare: async () => ({
        operation_id: 'op',
        cache: 'cache',
        delta: -10,
        previous: null,
        record: null,
        status: 'ABORTED',
      }),
      commit: async () => {
        throw new Error('an aborted operation must not commit');
      },
      abort: async () => {
        calls.push('abort');
      },
    };
    const quota: QuotaLedger = {
      reserve: async () => {
        throw new Error('an aborted operation must not reserve');
      },
      finalize: async () => {
        calls.push('finalize');
      },
      abort: async () => {
        calls.push('quota-abort');
      },
    };
    await expect(
      new PublicationProtocol(index, quota).execute('op', {
        kind: 'delete',
        store_hash: '0'.repeat(32),
      }),
    ).rejects.toThrow('aborted');
    expect(calls).toEqual(['quota-abort']);
  });
});
