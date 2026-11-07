import { describe, expect, it, vi } from 'vitest';
import { manifest } from '../../../shared/test-fixtures';
import type { UploadRow } from './upload-row';
import { UploadPublisher } from './publish';
import type { UploadStorage } from './storage';

const row: UploadRow = {
  job_id: 'job',
  cache: 'cache',
  cache_id: 'cache-id',
  incarnation: 'incarnation',
  staging_key: 'staging/job.nar.zst',
  upload_id: 'upload',
  state: 'PROCESSING',
  manifest,
  compressed_size: 1,
  idempotency_key: 'key',
  fingerprint: 'fingerprint',
  parts: {},
  error: null,
  result: null,
  chunks_key: null,
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
      processing_version: 'test',
      created_at: 1,
    };

    async function environment(text: () => Promise<string>) {
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
      const prepare = vi.fn(async () => ({
        ok: false,
        error: { code: 'unavailable', message: 'lost', status: 503 },
      }));
      const coordinator = {
        getCache: async () => ({
          ok: true,
          value: { id: 'cache-id', name: 'cache', lifecycle: 'ACTIVE' },
        }),
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
        CACHE_INDEX: { getByName: () => ({ prepare }) },
        CACHE_BUCKET: { get: async () => ({ text }) },
      } as unknown as Env;
      return { env, prepare };
    }

    function statefulStorage() {
      let result: UploadRow['result'] = null;
      return {
        row: () => ({ ...row, result }),
        setResult: (_: string, receipt: NonNullable<UploadRow['result']>) => {
          result = {
            ...receipt,
            published_at: result?.published_at ?? receipt.published_at,
          };
          return result;
        },
      } as unknown as UploadStorage;
    }

    it('sends an identical mutation when the clock has moved', async () => {
      const { env, prepare } = await environment(async () =>
        JSON.stringify(stored),
      );
      const publisher = new UploadPublisher(env, statefulStorage());
      const receipt = { manifest_key: 'm.json', deduplicated: false };
      vi.useFakeTimers({ now: 1_000_000 });
      try {
        await publisher.publish(receipt);
        vi.setSystemTime(2_000_000);
        await publisher.publish(receipt);
      } finally {
        vi.useRealTimers();
      }
      const [first, second] = prepare.mock.calls as unknown as [
        [{ mutation: unknown }],
        [{ mutation: unknown }],
      ];
      expect(JSON.stringify(second[0].mutation)).toBe(
        JSON.stringify(first[0].mutation),
      );
    });

    it('retries a failed manifest read instead of failing the upload', async () => {
      const { env } = await environment(async () => {
        throw new Error('connection reset');
      });
      await expect(
        new UploadPublisher(env, statefulStorage()).publish({
          manifest_key: 'm.json',
          deduplicated: false,
        }),
      ).rejects.toThrow('connection reset');
    });

    it('permanently rejects a manifest that is not JSON', async () => {
      const { env } = await environment(async () => 'not json');
      await expect(
        new UploadPublisher(env, statefulStorage()).publish({
          manifest_key: 'm.json',
          deduplicated: false,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_input', status: 422 },
      });
    });
  });
});
