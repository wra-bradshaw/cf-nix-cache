import { type RpcResult, failure, ok } from '../../../shared/rpc';
import { first, type SqlRow, text, integer } from '../../../shared/sql';
import { ensureWorkflow } from '../../../shared/workflows';
import { assertStoreHash } from '../../../shared/identifiers';
import { gcControl } from '../../gc/gc-adapters';
import {
  CHUNK_MAX_COMPRESSED_SIZE,
  CHUNK_MAX_RAW_SIZE,
  chunkKey,
  manifestKey,
  type ChunkClaim,
} from '../encoding';
import type {
  ChunkManifest,
  ProcessResult,
  UploadManifest,
  UploadState,
  UploadStateResponse,
} from '../types';
import {
  CHUNK_LIST_MAX_CHUNKS,
  chunkList,
  inlineVerifyLimit,
  MAX_NAR_SIZE,
  type StoredNar,
} from '../verify-stored';
import { assertValidRawHash } from '../verifier';
import type { UploadPublisher } from './publish';
import type { UploadStorage } from './storage';
import { toProcessJob, toStateResponse, type UploadRow } from './upload-row';

/** Parallel R2 HEADs when a session opens. The HEADs run outside the
 * session's serialized queue (`open` re-checks state after them), so a slow
 * fan-out never blocks chunk/complete calls on the same object. Bounded:
 * `open` rejects lists over `CHUNK_LIST_MAX_CHUNKS`, a manifest hit HEADs a
 * small canary sample instead of the full list (falling back to the full
 * check when any canary is gone), and duplicate hashes are deduped. Even
 * then the worst case would be 16384 HEADs, so `presentChunks` applies a
 * per-upload HEAD budget (`MAX_OPEN_HEADS` at `HEAD_CONCURRENCY`-wide): only
 * the first budget of unique hashes is HEADed and the rest are treated as
 * missing. Missing is safe — the client re-uploads those chunks and
 * `storeChunk` dedupes with conditional PUTs — while an unbounded HEAD
 * fan-out per open is not. Retries hit the `existing` early return, so the
 * budget applies once per upload.
 */
const HEAD_CONCURRENCY = 16;
/**
 * Per-upload R2 HEAD budget for `open`'s existence check. Keeps a manifest
 * miss from fanning out to 16384 HEADs: 1024 HEADs at 16-wide is ~64 rounds,
 * and anything beyond the budget is reported missing so the client sends it.
 * That over-reporting is safe but not free: the client re-uploads chunks the
 * bucket already holds (extra PUTs/bandwidth, deduped by conditional PUT in
 * `storeChunk`). A structured `console.warn` in `presentChunks` (with unique,
 * budget, and skipped counts) marks when the budget caps a check so the
 * redundant-upload cost is visible.
 */
const MAX_OPEN_HEADS = 1024;

/**
 * Exact fingerprint equality only, by design: the stored fingerprint must be
 * the sha256 hex of the canonical JSON (`fingerprintForEncodedUpload` in
 * `encoded.ts`). There is no backward compatibility with older fingerprint
 * forms — a row written by an older version compares unequal and reports an
 * idempotency conflict, which is the correct signal to push again.
 */
export interface OpenSessionInput {
  job_id: string;
  cache: string;
  cache_id: string;
  incarnation: string;
  chunks_key: string;
  manifest: UploadManifest;
  compressed_size: number;
  idempotency_key: string;
  fingerprint: string;
  chunks: ChunkClaim[];
}

export interface OpenedSession {
  state: UploadState;
  error: string | null;
  missing_chunks: string[];
}

/**
 * The caller verifies `inline` and `existing` plans, and writes the chunk list
 * to `chunks_key` before publishing them. The list lets the upload
 * workflow finish a publication interrupted in PROCESSING.
 */
export type CompletionPlan =
  | { kind: 'done'; state: UploadStateResponse }
  | {
      kind: 'existing';
      manifest_key: string;
      chunks_key: string;
      nar: StoredNar;
    }
  | { kind: 'inline'; chunks_key: string; nar: StoredNar };

export async function writeChunkList(
  bucket: R2Bucket,
  key: string,
  nar: StoredNar,
): Promise<void> {
  await bucket.put(key, JSON.stringify(chunkList(nar)), {
    httpMetadata: { contentType: 'application/json' },
  });
}

const IN_PROGRESS: UploadState[] = ['QUEUED', 'PROCESSING', 'PUBLISHING'];
const TERMINAL: UploadState[] = ['READY', 'FAILED', 'ABORTED'];

/**
 * A client-encoded upload: the client sends only the chunks the bucket lacks,
 * and completion checks the stored chunks instead of re-encoding a NAR.
 *
 * The upload holds a garbage collection lease from before it first looks for
 * existing chunks until publication. A chunk reported present could otherwise
 * be swept before the manifest that references it is published.
 */
export class UploadSession {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly storage: UploadStorage,
    private readonly publisher: UploadPublisher,
  ) {}

  /** Runs `body` after every earlier call has finished. */
  private serialized<T>(body: () => Promise<T>): Promise<T> {
    const result = this.queue.then(body, body);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private sql() {
    return this.ctx.storage.sql;
  }

  isSession(): boolean {
    return Boolean(
      first(this.sql().exec<SqlRow>('SELECT key FROM session WHERE key = 1')),
    );
  }

  leaseToken(): string | null {
    const row = first(
      this.sql().exec<SqlRow>('SELECT lease_token FROM session WHERE key = 1'),
    );
    return row?.lease_token ? text(row, 'lease_token') : null;
  }

  private missing(): string[] {
    return [
      ...this.sql().exec<{ raw_hash: string }>(
        'SELECT DISTINCT raw_hash FROM session_chunks WHERE present = 0 ORDER BY raw_hash',
      ),
    ].map((row) => text(row, 'raw_hash'));
  }

  private opened(row: UploadRow): OpenedSession {
    return {
      state: row.state,
      error: row.error,
      missing_chunks: row.state === 'UPLOADING' ? this.missing() : [],
    };
  }

  private nar(row: UploadRow): StoredNar {
    return {
      nar_hash: row.manifest.nar_hash,
      nar_size: row.manifest.nar_size,
      chunks: [
        ...this.sql().exec<{ raw_hash: string; raw_size: number }>(
          'SELECT raw_hash, raw_size FROM session_chunks ORDER BY idx',
        ),
      ].map((chunk) => ({
        raw_hash: text(chunk, 'raw_hash'),
        raw_size: integer(chunk, 'raw_size'),
      })),
    };
  }

  /**
   * Pure input checks for `open`. Returns a failure result when the input is
   * invalid, or null when it is valid. Kept outside the serialized queue:
   * validation touches no durable state, so holding the queue for it would
   * only block other calls on the same object.
   */
  private validateOpenInput(
    input: OpenSessionInput,
  ): RpcResult<OpenedSession> | null {
    // Defense in depth: `openEncoded` already rejects an empty list and
    // caps it at `MAX_CHUNKS_PER_UPLOAD` (= `CHUNK_LIST_MAX_CHUNKS`), but
    // the DO boundary must not trust it — otherwise a caller could force
    // an unbounded HEAD fan-out in `presentChunks` (or publish an empty
    // NAR the verifier would reject later).
    if (input.chunks.length === 0)
      return failure(
        'invalid_input',
        'upload declares an invalid number of chunks',
        422,
      );
    if (input.chunks.length > CHUNK_LIST_MAX_CHUNKS)
      return failure(
        'invalid_input',
        `upload declares too many chunks (max ${CHUNK_LIST_MAX_CHUNKS})`,
        422,
      );
    // Defense in depth: `openEncoded` validates the manifest via schema +
    // `validateUploadManifest`, but the DO boundary must not trust it — a
    // malformed nar_hash must never become an R2 key in the manifest-hit
    // check below, and a bad nar_size/store_hash must never be stored for
    // completion to trust later.
    try {
      assertValidRawHash(input.manifest.nar_hash);
    } catch {
      return failure(
        'invalid_input',
        'upload declares an invalid NAR hash',
        422,
      );
    }
    // Upper bound is `MAX_NAR_SIZE` (the process-job schema maximum, shared
    // with `openEncoded` in `encoded.ts`): larger NARs can never verify.
    if (
      !Number.isSafeInteger(input.manifest.nar_size) ||
      input.manifest.nar_size < 1 ||
      input.manifest.nar_size > MAX_NAR_SIZE
    )
      return failure(
        'invalid_input',
        'upload declares an invalid NAR size',
        422,
      );
    try {
      assertStoreHash(input.manifest.store_hash);
    } catch {
      return failure(
        'invalid_input',
        'upload declares an invalid store hash',
        422,
      );
    }
    // Defense in depth: `openEncoded` already validates these, but the DO
    // boundary must not trust it — a malformed hash must never become an
    // R2 key in the `presentChunks` HEAD fan-out below, and a bad
    // compressed size/hash must never be stored for `verifyChunk` to
    // trust later.
    for (const chunk of input.chunks) {
      try {
        assertValidRawHash(chunk.raw_hash);
      } catch {
        return failure(
          'invalid_input',
          'upload declares an invalid chunk hash',
          422,
        );
      }
      if (
        !Number.isSafeInteger(chunk.raw_size) ||
        chunk.raw_size < 1 ||
        chunk.raw_size > CHUNK_MAX_RAW_SIZE
      )
        return failure(
          'invalid_input',
          'upload declares an invalid chunk size',
          422,
        );
      try {
        assertValidRawHash(chunk.compressed_hash);
      } catch {
        return failure(
          'invalid_input',
          'upload declares an invalid compressed chunk hash',
          422,
        );
      }
      if (
        !Number.isSafeInteger(chunk.compressed_size) ||
        chunk.compressed_size < 1 ||
        chunk.compressed_size > CHUNK_MAX_COMPRESSED_SIZE
      )
        return failure(
          'invalid_input',
          'upload declares an invalid compressed chunk size',
          422,
        );
    }
    // `openEncoded` already rejects these, but the DO boundary must not
    // trust it — duplicates would store the same hash twice and skew the
    // NAR the session verifies at completion.
    if (
      new Set(input.chunks.map((chunk) => chunk.raw_hash)).size !==
      input.chunks.length
    )
      return failure('invalid_input', 'upload declares duplicate chunks', 422);
    // The DO trusts nothing about the manifest/chunk size relation from the
    // encoded layer: a skewed sum would store a NAR claim its chunks can
    // never verify to.
    if (
      input.chunks.reduce((sum, chunk) => sum + chunk.raw_size, 0) !==
      input.manifest.nar_size
    )
      return failure(
        'invalid_input',
        'chunk sizes do not add up to the NAR size',
        422,
      );
    return null;
  }

  private existingOpened(
    input: OpenSessionInput,
    existing: UploadRow,
  ): RpcResult<OpenedSession> {
    const sameMetadata =
      existing.idempotency_key === input.idempotency_key &&
      existing.fingerprint === input.fingerprint;
    if (!sameMetadata)
      return failure(
        'idempotency_conflict',
        'upload metadata changed during retry',
        409,
      );
    return ok(this.opened(existing));
  }

  /**
   * Non-blocking open: validation, the GC lease round-trip, and all R2
   * HEADs run outside the serialized queue; only the pre-check and the
   * final conditional insert hold it. The lock is released during the HEADs
   * and the row is re-checked after them, because a concurrent open may have
   * won while the HEADs were in flight — the loser releases its lease and
   * reports the winner's state instead of inserting twice.
   */
  async open(input: OpenSessionInput): Promise<RpcResult<OpenedSession>> {
    const invalid = this.validateOpenInput(input);
    if (invalid) return invalid;
    const early = await this.serialized(async () => {
      const existing = this.storage.row();
      return existing ? this.existingOpened(input, existing) : null;
    });
    if (early) return early;
    const gc = gcControl(this.env);
    const lease = await gc.acquireLease({ job_id: input.job_id });
    if (!lease.ok) return lease;
    const token = lease.value.token;
    if (!token)
      return failure(
        'gc_in_progress',
        'garbage collection is deleting objects; retry shortly',
        503,
      );
    // The lease (acquired above, before the manifest HEAD) is held until
    // publication, so chunks the HEADs report present cannot be swept before
    // the manifest that references them is published.
    let present: Set<string>;
    let existingManifest: boolean;
    try {
      ({ present, existingManifest } = await this.checkPresent(input));
    } catch (error) {
      await gc
        .releaseLease({ job_id: input.job_id, token })
        .catch(() => undefined);
      throw error;
    }
    let stored = false;
    try {
      const result = await this.serialized(
        async (): Promise<RpcResult<OpenedSession>> => {
          // Re-check after the unlocked HEADs: a concurrent open may have
          // inserted while they were in flight.
          const existing = this.storage.row();
          if (existing) return this.existingOpened(input, existing);
          // One write transaction via `insertOpen`: the storage layer owns its
          // `transactionSync`, which cannot nest inside an outer one here. A
          // false return is unexpected — the re-check above runs in the same
          // serialized section with no awaits to `insertOpen`, so no
          // concurrent open can slip between — but it is handled defensively
          // as a lost open race (report the winner's row) rather than
          // throwing, in case a future writer bypasses the queue. See
          // `insertOpen` for the matching half of this contract.
          const inserted = this.storage.insertOpen(
            input,
            { leaseToken: token, existingManifest },
            input.chunks.map((chunk) => ({
              ...chunk,
              present: present.has(chunk.raw_hash),
            })),
          );
          if (!inserted) {
            const current = this.storage.row();
            if (!current) return failure('not_found', 'upload not found', 404);
            return this.existingOpened(input, current);
          }
          stored = true;
          const openedRow = this.storage.row();
          if (!openedRow) return failure('not_found', 'upload not found', 404);
          return ok(this.opened(openedRow));
        },
      );
      if (!stored)
        await gc
          .releaseLease({ job_id: input.job_id, token })
          .catch(() => undefined);
      return result;
    } catch (error) {
      if (!stored)
        await gc
          .releaseLease({ job_id: input.job_id, token })
          .catch(() => undefined);
      throw error;
    }
  }

  /**
   * Manifest-hit fast path plus the full existence check. Runs outside the
   * serialized queue (see `open`).
   *
   * Safety pin: a manifest hit trusts the manifest's chunks without HEADing
   * them all because two invariants keep them live. First, the upload's GC
   * lease (acquired before the manifest HEAD, held until publication) blocks
   * the sweep gate, and GC deletes manifests before the chunks they reference
   * (`GcLedger.nextDeletions` orders `manifests/` before `chunks/`, so an
   * interrupted sweep never leaves a manifest whose chunks are gone). A later
   * upload of the same NAR therefore cannot find a swept manifest's orphaned
   * chunks missing. Second, the `existing` completion path re-reads the
   * manifest with `readManifest` (R2 size pre-check plus UTF-8 byte-length
   * cap, schema, and per-chunk key/size/duplicate checks), so a corrupt or
   * tampered manifest is rejected before publication. The canary sample below
   * is only defense against out-of-band deletion (a manifest that survived
   * while its chunks did not): when any canary is gone the code falls back to
   * the full per-chunk check rather than reporting missing=[].
   *
   * Fail-closed: a missing canary always falls back to the full check, so the
   * fast path reports present only when the sample is intact — it never
   * invents presence. The residual hole is out-of-band deletion confined to
   * non-sampled chunks: the open would report missing=[] and the `existing`
   * completion path trusts the re-validated manifest without re-HEADing every
   * chunk. That hole is accepted because only the GC sweep deletes chunks and
   * it cannot produce it (the lease plus manifests-first ordering above); the
   * canary is a cheap tripwire, not the guarantee.
   *
   * Cost: a manifest hit costs 1 manifest HEAD plus 3 canary HEADs instead of
   * up to `MAX_OPEN_HEADS` budgeted HEADs (a canary miss costs those 4 plus
   * the full check). The sample stays at three even though HEAD budget
   * remains: spending budget here would only shrink what the fallback full
   * check may use, while three spread probes (first, middle, last) already
   * catch the plausible partial-loss shapes — e.g. a manifest whose head
   * chunk survived while the tail did not — for 2 extra HEADs on the fast
   * path instead of one.
   */
  private async checkPresent(
    input: OpenSessionInput,
  ): Promise<{ present: Set<string>; existingManifest: boolean }> {
    const reused = await this.env.CACHE_BUCKET.head(
      manifestKey(input.manifest.nar_hash),
    );
    if (!reused)
      return {
        present: await this.presentChunks(input.job_id, input.chunks),
        existingManifest: false,
      };
    // A stored manifest's chunks cannot have been swept under the invariants
    // pinned above (lease + manifests-first sweep ordering). Still, a manifest
    // that survived while its chunks did not (out-of-band deletion) would
    // report missing=[] and fail later at verification, so probe a small
    // canary sample and fall back to the full existence check when any canary
    // is gone. Three probes (first, middle, last) catch partial loss a single
    // probe would miss — e.g. a manifest whose head chunk survived while the
    // tail did not — for 2 extra HEADs on the fast path instead of one.
    // Reporting present on a canary hit is safe: the `existing` completion
    // path re-validates the manifest with `readManifest` before publishing,
    // and the lease keeps the chunks it names live until then.
    const order = [...new Set(input.chunks.map((chunk) => chunk.raw_hash))];
    const canaries = [
      order[0]!,
      order[Math.floor(order.length / 2)]!,
      order[order.length - 1]!,
    ].filter((hash, index, all) => all.indexOf(hash) === index);
    const probes = await Promise.all(
      canaries.map((hash) => this.env.CACHE_BUCKET.head(chunkKey(hash))),
    );
    if (probes.every((probe) => probe !== null))
      return {
        present: new Set(input.chunks.map((chunk) => chunk.raw_hash)),
        existingManifest: true,
      };
    return {
      present: await this.presentChunks(input.job_id, input.chunks),
      existingManifest: true,
    };
  }

  private async presentChunks(
    jobId: string,
    chunks: ChunkClaim[],
  ): Promise<Set<string>> {
    const unique = [...new Set(chunks.map((chunk) => chunk.raw_hash))];
    const present = new Set<string>();
    // Budgeted: beyond MAX_OPEN_HEADS the chunk is reported missing without a
    // HEAD. The client then uploads it and `storeChunk` dedupes with a
    // conditional PUT, so over-reporting missing is safe while an unbounded
    // HEAD fan-out is not. The trade is redundant uploads (extra PUTs and
    // bandwidth for chunks the bucket already holds), so log the capped
    // check with its counts.
    if (unique.length > MAX_OPEN_HEADS)
      console.warn({
        message:
          'upload open capped HEAD fan-out; remainder reported missing and re-uploaded',
        job_id: jobId,
        unique_chunks: unique.length,
        head_budget: MAX_OPEN_HEADS,
        reported_missing_without_head: unique.length - MAX_OPEN_HEADS,
      });
    const budgeted = unique.slice(0, MAX_OPEN_HEADS);
    for (let start = 0; start < budgeted.length; start += HEAD_CONCURRENCY) {
      await Promise.all(
        budgeted.slice(start, start + HEAD_CONCURRENCY).map(async (hash) => {
          if (await this.env.CACHE_BUCKET.head(chunkKey(hash)))
            present.add(hash);
        }),
      );
    }
    return present;
  }

  /** What an uploaded chunk must be, if the session still needs it. */
  async chunkClaim(
    rawHash: string,
  ): Promise<RpcResult<ChunkClaim & { present: boolean }>> {
    const row = this.storage.row();
    if (!row || !this.isSession())
      return failure('not_found', 'upload session not found', 404);
    if (row.state !== 'UPLOADING')
      return failure('not_uploadable', 'upload is not accepting chunks', 409);
    const chunk = first(
      this.sql().exec<SqlRow>(
        // Every non-aggregated column is in the GROUP BY: raw_hash is
        // unique per upload (duplicates are rejected at open), so the
        // grouping is a single row and MIN(present) just reads its flag.
        // Listing the bare columns (instead of bare-selecting them) keeps
        // SQLite from picking an arbitrary row if that invariant ever broke.
        'SELECT raw_hash, raw_size, compressed_hash, compressed_size, MIN(present) AS present FROM session_chunks WHERE raw_hash = ? GROUP BY raw_hash, raw_size, compressed_hash, compressed_size',
        rawHash,
      ),
    );
    if (!chunk)
      return failure('unknown_chunk', 'chunk is not part of this upload', 404);
    return ok({
      raw_hash: rawHash,
      raw_size: integer(chunk, 'raw_size'),
      compressed_hash: text(chunk, 'compressed_hash'),
      compressed_size: integer(chunk, 'compressed_size'),
      present: integer(chunk, 'present') === 1,
    });
  }

  /** Chunks still to send; empty once the upload stops accepting them. */
  async missingChunks(): Promise<RpcResult<string[]>> {
    const row = this.storage.row();
    if (!row || !this.isSession())
      return failure('not_found', 'upload session not found', 404);
    return ok(row.state === 'UPLOADING' ? this.missing() : []);
  }

  async chunkStored(rawHash: string): Promise<RpcResult<void>> {
    return this.serialized(async () => {
      const row = this.storage.row();
      if (!row || !this.isSession())
        return failure('not_found', 'upload session not found', 404);
      if (TERMINAL.includes(row.state))
        return failure(
          'invalid_transition',
          'upload has already finished',
          409,
        );
      if (row.state !== 'UPLOADING')
        return failure('not_uploadable', 'upload is not accepting chunks', 409);
      const known = first(
        this.sql().exec<SqlRow>(
          'SELECT 1 AS known FROM session_chunks WHERE raw_hash = ? LIMIT 1',
          rawHash,
        ),
      );
      if (!known)
        return failure(
          'unknown_chunk',
          'chunk is not part of this upload',
          404,
        );
      // Conditional write: the state is re-checked inside the same write
      // transaction, so a concurrent completion that slipped between the
      // checks above and this write cannot mark a chunk present after the
      // upload stopped accepting chunks. Only UPLOADING (or a COMPLETING it
      // just left) may record presence; anything else reports instead of
      // writing.
      const accepted = this.ctx.storage.transactionSync(() => {
        const current = this.storage.row();
        if (
          !current ||
          (current.state !== 'UPLOADING' && current.state !== 'COMPLETING')
        )
          return false;
        this.sql().exec(
          'UPDATE session_chunks SET present = 1 WHERE raw_hash = ?',
          rawHash,
        );
        return true;
      });
      if (!accepted)
        return failure('not_uploadable', 'upload is not accepting chunks', 409);
      return ok();
    });
  }

  /**
   * Moves the upload to COMPLETING and says how to verify it: in the calling
   * Worker for small NARs, or by the upload workflow for large ones.
   */
  beginComplete(): Promise<RpcResult<CompletionPlan>> {
    return this.serialized(async () => {
      const row = this.storage.row();
      if (!row) return failure('not_found', 'upload session not found', 404);
      if (
        ![
          'UPLOADING',
          'COMPLETING',
          'QUEUED',
          'PROCESSING',
          'PUBLISHING',
          'READY',
          'FAILED',
          'ABORTED',
        ].includes(row.state)
      )
        return failure(
          'invalid_transition',
          'upload was never opened; push again with a current cf-nix-cache',
          409,
        );
      if (!this.isSession())
        return failure('not_found', 'upload session not found', 404);
      if (IN_PROGRESS.includes(row.state)) {
        // Best-effort like `state()`: a Workflows outage must not turn a poll
        // into a 500. The client's next `state` poll retries the
        // reconciliation, so report the stored state now.
        try {
          await ensureWorkflow(
            this.env.PROCESS_UPLOAD!,
            row.job_id,
            toProcessJob(row),
          );
        } catch (error) {
          console.error('upload workflow reconciliation failed', error);
        }
        const current = this.storage.row();
        if (!current) return failure('not_found', 'upload not found', 404);
        return ok({
          kind: 'done',
          state: toStateResponse(current),
        });
      }
      if (TERMINAL.includes(row.state))
        return ok({ kind: 'done', state: toStateResponse(row) });
      if (row.state === 'UPLOADING') {
        const missing = this.missing();
        if (missing.length)
          return failure(
            'chunks_missing',
            `${missing.length} chunks have not been uploaded`,
            409,
          );
        // The serialized queue is the only writer here and the state was
        // just read as UPLOADING with no awaits in between, so the
        // conditional write must succeed; a false return is an invariant
        // violation, not a race.
        if (!this.storage.setState(row.job_id, ['UPLOADING'], 'COMPLETING'))
          throw new Error('upload left UPLOADING before completion started');
      }
      const nar = this.nar(row);
      const reused = first(
        this.sql().exec<SqlRow>(
          'SELECT existing_manifest FROM session WHERE key = 1',
        ),
      );
      if (reused && integer(reused, 'existing_manifest') === 1)
        return ok({
          kind: 'existing',
          manifest_key: manifestKey(row.manifest.nar_hash),
          chunks_key: row.chunks_key,
          nar,
        });
      if (row.manifest.nar_size <= inlineVerifyLimit(this.env))
        return ok({ kind: 'inline', chunks_key: row.chunks_key, nar });
      await writeChunkList(this.env.CACHE_BUCKET, row.chunks_key, nar);
      // The workflow acquires the lease under the same job ID, replacing this
      // upload's token without a gap in which chunks could be swept.
      // The serialized queue is the only writer of this transition, but
      // awaits above (the R2 write) let a fail/abort interleave, so a false
      // return means the upload moved on. The chunk list just written is then
      // orphaned: delete it best-effort (the bucket's lifecycle rule removes
      // orphaned objects left behind, as in publication) and report the
      // current state instead of proceeding to queue a workflow for a
      // terminal upload.
      if (!this.storage.setQueued(row.job_id)) {
        await this.env.CACHE_BUCKET.delete(row.chunks_key).catch(
          (error: unknown) => console.error('chunk list cleanup failed', error),
        );
        const current = this.storage.row();
        if (!current) return failure('not_found', 'upload not found', 404);
        return ok({
          kind: 'done',
          state: toStateResponse(current),
        });
      }
      const queued = this.storage.row();
      if (!queued) return failure('not_found', 'upload not found', 404);
      // Best-effort like `state()` and the IN_PROGRESS arm above: a
      // Workflows outage must not fail completion after the upload was
      // queued. The workflow starts (or the next `state` poll restarts it)
      // and the client observes QUEUED now.
      try {
        await ensureWorkflow(
          this.env.PROCESS_UPLOAD!,
          row.job_id,
          toProcessJob(queued),
        );
      } catch (error) {
        console.error('upload workflow reconciliation failed', error);
      }
      const done = this.storage.row();
      if (!done) return failure('not_found', 'upload not found', 404);
      return ok({ kind: 'done', state: toStateResponse(done) });
    });
  }

  /** Publishes a manifest the caller verified (or found) under the lease. */
  publishVerified(
    result: ProcessResult,
    manifest?: ChunkManifest,
  ): Promise<RpcResult<UploadStateResponse>> {
    return this.serialized(async () => {
      const row = this.storage.row();
      if (!row) return failure('not_found', 'upload not found', 404);
      if (row.state !== 'COMPLETING') return ok(toStateResponse(row));
      const token = this.leaseToken();
      const gc = gcControl(this.env);
      const lease = token
        ? await gc.prepublish({
            job_id: row.job_id,
            token,
            manifest_key: result.manifest_key,
          })
        : null;
      if (lease && !lease.ok) return lease;
      if (!lease?.value.valid) {
        // Conditional: an await above let fail/abort interleave, so a false
        // return means the upload moved on (e.g. a concurrent publish
        // reached READY). Fall through to the re-read below, which reports
        // the current state instead of assuming the failure was recorded.
        this.storage.setError(
          row.job_id,
          'the upload held its garbage collection lease too long; push again',
        );
        const current = this.storage.row();
        if (!current) return failure('not_found', 'upload not found', 404);
        return ok(toStateResponse(current));
      }
      // Awaits above (the lease round-trip) let a fail/abort interleave, so
      // a false return means the upload moved on; report its current state
      // instead of publishing under a stale COMPLETING.
      if (!this.storage.setState(row.job_id, ['COMPLETING'], 'PROCESSING')) {
        const current = this.storage.row();
        if (!current) return failure('not_found', 'upload not found', 404);
        return ok(toStateResponse(current));
      }
      const published = await this.publisher.publish(result, manifest);
      if (!published.ok) {
        if (published.error.status >= 500) {
          // A retryable failure leaves PROCESSING. Start the upload
          // workflow now, so the publication is finished even if this client
          // never asks about the upload again.
          await ensureWorkflow(
            this.env.PROCESS_UPLOAD!,
            row.job_id,
            toProcessJob(this.storage.row() ?? row),
          ).catch((error: unknown) =>
            console.error('upload workflow reconciliation failed', error),
          );
          return published;
        }
        // Conditional: the awaits above let a concurrent publish reach
        // READY, which must not be clobbered back to FAILED. A false return
        // means the terminal state won; the re-read after releaseLease
        // reports it instead of assuming the failure was recorded.
        this.storage.setError(
          row.job_id,
          `${published.error.code}: ${published.error.message}`,
        );
      }
      await this.releaseLease();
      const finished = this.storage.row();
      if (!finished) return failure('not_found', 'upload not found', 404);
      return ok(toStateResponse(finished));
    });
  }

  /** Marks the upload FAILED because its content was rejected. */
  reject(message: string): Promise<RpcResult<UploadStateResponse>> {
    return this.serialized(async () => {
      const row = this.storage.row();
      if (!row) return failure('not_found', 'upload not found', 404);
      if (row.state === 'UPLOADING' || row.state === 'COMPLETING') {
        // Conditional: an await is not needed here, but abort/fail still
        // race on the serialized queue's callers. A false return means the
        // row left UPLOADING/COMPLETING; the re-read below reports where it
        // went instead of assuming the rejection was recorded.
        this.storage.setError(row.job_id, message);
        await this.releaseLease();
      }
      const current = this.storage.row();
      if (!current) return failure('not_found', 'upload not found', 404);
      return ok(toStateResponse(current));
    });
  }

  /** Best-effort: an unreleased lease only delays a sweep until it expires. */
  async releaseLease(): Promise<void> {
    const row = this.storage.row();
    const token = this.leaseToken();
    if (!row || !token) return;
    try {
      await gcControl(this.env).releaseLease({ job_id: row.job_id, token });
    } catch (error) {
      console.error('gc lease release failed', error);
    }
  }
}
