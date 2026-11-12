import { describe, expect, it, vi } from 'vitest';
import { manifest } from '../../../shared/test-fixtures';
import { failure, ok, type RpcResult } from '../../../shared/rpc';
import type { PathRecord } from '../../cache/types';
import type { UploadRow } from './upload-row';
import { UploadPublisher } from './publish';
import type { UploadStorage } from './storage';

const row: UploadRow = {
  job_id: 'job',
  cache: 'cache',
  cache_id: 'cache-id',
  incarnation: 'incarnation',
  chunks_key: 'staging/job.chunks.json',
  state: 'PROCESSING',
  manifest,
  compressed_size: 1,
  idempotency_key: 'key',
  fingerprint: 'fingerprint',
  error: null,
  result: null,
};

describe('upload publication', () => {
  it('classifies a removed cache as a permanent failure', async () => {
    const env = {
      SYSTEM_CONTROL: {
        getByName: () => ({
          getCache: async () => ({
            ok: false,
            error: {
              code: 'not_found',
              message: 'cache not found',
              status: 404,
            },
          }),
        }),
      },
    } as unknown as Env;
    const storage = { row: () => row } as unknown as UploadStorage;
    const publisher = new UploadPublisher(env, storage);
    await expect(
      publisher.publish({
        manifest_key: 'manifests/key.json',
        deduplicated: false,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'not_found', message: 'cache not found', status: 404 },
    });
  });

  describe('retries', () => {
    const hash = (character: string) => `sha256:${character.repeat(52)}`;
    const stored = {
      encoding_id: 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1',
      nar_hash: manifest.nar_hash,
      nar_size: manifest.nar_size,
      file_hash: hash('1'),
      file_size: 1,
      chunks: [
        {
          raw_hash: hash('2'),
          raw_size: manifest.nar_size,
          compressed_hash: hash('3'),
          compressed_size: 1,
          key: `chunks/fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1/${hash('2')}.zst`,
        },
      ],
    };

    interface EnvironmentOptions {
      upsert?: (record: PathRecord) => Promise<RpcResult<unknown>>;
      reportUsage?: () => Promise<RpcResult<void>>;
    }

    async function environment(
      text: () => Promise<string>,
      options: EnvironmentOptions = {},
    ) {
      const { privateKey } = (await crypto.subtle.generateKey(
        { name: 'Ed25519' },
        true,
        ['sign', 'verify'],
      )) as CryptoKeyPair;
      const reference = {
        id: 'cache-id',
        name: 'cache',
        incarnation: 'incarnation',
        coordinator_id: '0'.repeat(64),
        lifecycle: 'ACTIVE',
      };
      const upserts: PathRecord[] = [];
      const shard = {
        upsert: async (record: PathRecord) => {
          upserts.push(record);
          return options.upsert
            ? options.upsert(record)
            : ok({
                previous_size: null,
                bytes: record.file_size,
                revision: upserts.length,
              });
        },
      };
      const reportUsage = vi.fn(options.reportUsage ?? (async () => ok()));
      const coordinator = {
        getCache: async () => ({
          ok: true,
          value: { id: 'cache-id', name: 'cache', lifecycle: 'ACTIVE' },
        }),
        reportUsage,
      };
      const env = {
        NIX_PRIVATE_JWK: JSON.stringify(
          await crypto.subtle.exportKey('jwk', privateKey),
        ),
        NIX_SIGNING_KEY_NAME: 'test-1',
        SYSTEM_CONTROL: {
          getByName: () => ({
            getCache: async () => ({ ok: true, value: reference }),
          }),
        },
        CACHE_COORDINATOR: {
          idFromString: (id: string) => id,
          get: () => coordinator,
        },
        CACHE_INDEX: { getByName: () => shard },
        CACHE_BUCKET: {
          get: async () => ({ text }),
          delete: async () => undefined,
        },
      } as unknown as Env;
      return { env, upserts, reportUsage };
    }

    function statefulStorage() {
      let result: UploadRow['result'] = null;
      let state: UploadRow['state'] = 'PROCESSING';
      return {
        row: () => ({ ...row, state, result }),
        setResult: (
          _jobId: string,
          receipt: NonNullable<UploadRow['result']>,
        ) => {
          result = {
            ...receipt,
            published_at: result?.published_at ?? receipt.published_at,
          };
          state = 'PUBLISHING';
          return { ...result, wrote: true as const };
        },
        setState: (_jobId: string, _from: unknown, to: UploadRow['state']) => {
          state = to;
          return true;
        },
      } as unknown as UploadStorage;
    }

    const receipt = { manifest_key: 'm.json', deduplicated: false };

    it('writes the same record on a retry after the clock moved', async () => {
      let attempts = 0;
      const { env, upserts } = await environment(
        async () => JSON.stringify(stored),
        {
          upsert: async (record) =>
            attempts++ === 0
              ? failure('unavailable', 'lost', 503)
              : ok({
                  previous_size: null,
                  bytes: record.file_size,
                  revision: 1,
                }),
        },
      );
      const publisher = new UploadPublisher(env, statefulStorage());
      vi.useFakeTimers({ now: 1_000_000 });
      try {
        await publisher.publish(receipt);
        vi.setSystemTime(2_000_000);
        await publisher.publish(receipt);
      } finally {
        vi.useRealTimers();
      }
      expect(upserts).toHaveLength(2);
      expect(upserts[1]).toEqual(upserts[0]);
    });

    it('does not fail the upload when reporting usage fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { env } = await environment(async () => JSON.stringify(stored), {
        reportUsage: async () => failure('unavailable', 'lost', 503),
      });
      await expect(
        new UploadPublisher(env, statefulStorage()).publish(receipt),
      ).resolves.toMatchObject({ ok: true });
    });

    it('fails the upload permanently when the cache is being deleted', async () => {
      const { env } = await environment(async () => JSON.stringify(stored), {
        upsert: async () => failure('cache_deleting', 'deleting', 410),
      });
      await expect(
        new UploadPublisher(env, statefulStorage()).publish(receipt),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: 'publication_failed',
          message: 'deleting',
          status: 410,
        },
      });
    });

    it('retries a failed manifest read instead of failing the upload', async () => {
      const { env } = await environment(async () => {
        throw new Error('connection reset');
      });
      await expect(
        new UploadPublisher(env, statefulStorage()).publish(receipt),
      ).rejects.toThrow('connection reset');
    });

    it('permanently rejects a manifest that is not JSON', async () => {
      const { env } = await environment(async () => 'not json');
      await expect(
        new UploadPublisher(env, statefulStorage()).publish(receipt),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_input', status: 422 },
      });
    });
  });
});
