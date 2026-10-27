import { describe, expect, it } from 'vitest';
import { manifest } from '../../domain/test-fixtures';
import type { UploadRow } from './model';
import { UploadPublication } from './publication';
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
    const publication = new UploadPublication(
      {} as DurableObjectState,
      env,
      storage,
    );
    await expect(
      publication.publish({
        manifest_key: 'manifests/key.json',
        manifest: {} as never,
        deduplicated: false,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'not_found', message: 'cache not found', status: 404 },
    });
  });
});
