import { now } from '../../shared/clock';
import { DomainError } from '../../shared/errors';
import { idStub, unwrapRpc } from '../../shared/rpc';
import type { Allocation } from '../cache/durable/upload-allocations';
import { coordinator } from '../cache/stubs';
import type { CacheState } from '../cache/types';
import type { UploadManifest, UploadState } from './types';

const FINISHED_BADLY: UploadState[] = ['FAILED', 'ABORTED'];

/**
 * Allocates an upload, joining another push's upload of the same NAR while it
 * is in flight.
 */
export async function allocateUpload(
  env: Env,
  cache: CacheState,
  request: {
    operation_id: string;
    fingerprint: string;
    manifest: UploadManifest;
  },
): Promise<{ allocation: Allocation; state?: UploadState }> {
  const stub = coordinator(env, cache.reference);
  const base = {
    operation_id: request.operation_id,
    fingerprint: request.fingerprint,
    store_hash: request.manifest.store_hash,
    nar_hash: request.manifest.nar_hash,
  };
  let allocation = unwrapRpc(
    await stub.allocateUpload({ ...base, now: now(), merge: true }),
  );
  for (let attempt = 0; allocation.merged; attempt += 1) {
    const access = await idStub(env.UPLOAD_JOB, allocation.id).access();
    if (access.ok && !access.value.encoded)
      throw new DomainError(
        'invalid_transition',
        'upload is no longer supported; push again with a current cf-nix-cache',
        409,
      );
    if (
      access.ok &&
      access.value.encoded &&
      !FINISHED_BADLY.includes(access.value.state)
    )
      return { allocation, state: access.value.state };
    // A failed upload is replaced, so the next push of the path joins this one.
    allocation = unwrapRpc(
      await stub.allocateUpload({
        ...base,
        now: now(),
        merge: attempt < 2,
        replace: allocation.id,
      }),
    );
  }
  return { allocation };
}
