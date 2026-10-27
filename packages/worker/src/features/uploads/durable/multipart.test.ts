import { describe, expect, it } from 'vitest';
import type { CompleteUploadRequest } from '../../../types';
import { UploadMultipart } from './multipart';
import type { UploadStorage } from './storage';

describe('multipart completion', () => {
  it('returns a validation failure instead of throwing across RPC', async () => {
    const storage = {
      row: () => {
        throw new Error('validation must happen before reading state');
      },
    } as unknown as UploadStorage;
    const multipart = new UploadMultipart(
      {} as DurableObjectState,
      {} as Env,
      storage,
    );
    await expect(
      multipart.complete({
        parts: [{ part_number: 'one' }],
      } as unknown as CompleteUploadRequest),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'validation_failed', status: 422 },
    });
  });
});
