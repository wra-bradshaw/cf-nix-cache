import { describe, expect, it, vi } from 'vitest';
import type { CompleteUploadRequest } from '../types';
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

  it('rejects unknown parts while the upload can still be corrected', async () => {
    const setCompleting = vi.fn();
    const storage = {
      row: () => ({
        job_id: 'job',
        upload_id: 'upload',
        state: 'UPLOADING',
        parts: { 1: 'real-etag' },
      }),
      setCompleting,
    } as unknown as UploadStorage;
    const multipart = new UploadMultipart(
      {} as DurableObjectState,
      {} as Env,
      storage,
    );
    await expect(
      multipart.complete({ parts: [{ part_number: 1, etag: 'wrong' }] }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_part', status: 400 },
    });
    expect(setCompleting).not.toHaveBeenCalled();
  });
});
