import { now } from '../../shared/clock';
import { idStub, unwrapRpc } from '../../shared/rpc';
import type { Allocation } from '../cache/durable/upload-allocations';
import { coordinator } from '../cache/stubs';
import type { CacheState } from '../cache/types';
import type { UploadManifest, UploadState } from './types';

const FINISHED_BADLY: UploadState[] = ['FAILED', 'ABORTED'];
const RECEIVING: UploadState[] = ['CREATED', 'UPLOADING', 'COMPLETING'];

/**
 * Allocates an upload, joining another push's upload of the same NAR while it
 * is in flight. `joinReceiving` says whether the client can wait for an upload
 * that is still receiving data. Older CLIs cannot: given an upload in
 * UPLOADING, they would send their own parts into it.
 */
export async function allocateUpload(
  env: Env,
  cache: CacheState,
  request: {
    operation_id: string;
    fingerprint: string;
    manifest: UploadManifest;
  },
  joinReceiving: boolean,
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
    const state = access.ok ? access.value.state : null;
    const finished = state === null || FINISHED_BADLY.includes(state);
    if (!finished && (joinReceiving || !RECEIVING.includes(state)))
      return { allocation, state };
    // A failed upload is replaced, so the next push of the path joins this
    // one. One this client cannot join stays, and this push uploads alone.
    allocation = unwrapRpc(
      await stub.allocateUpload({
        ...base,
        now: now(),
        merge: finished && attempt < 2,
        ...(finished ? { replace: allocation.id } : {}),
      }),
    );
  }
  return { allocation };
}
