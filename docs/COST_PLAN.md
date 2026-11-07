# Cost and performance plan

Status: Stages 0, 1 and 3 are implemented; Stage 2 and the pool of 1c were
not built as such (see [Implementation](#implementation)). The benchmarks were
run on a throwaway installation, and their results are under
[Results](#results).

The goal is to make pushes as cheap and as fast as possible without weakening
the guarantees in [ARCHITECTURE.md](ARCHITECTURE.md): garbage-collection
safety, the publication protocol, quota reservations, idempotent retries, and
stock Nix compatibility.

The plan is in four stages. Stages 0 and 1 are worth doing regardless. Stage 3
replaces most of what Stage 2 would build, so do one or the other, not both.

## What we measured

One system rebuild on 2026-11-07, pushed by the post-build hook in the
dotfiles (one `cf-nix-cache push` per finished derivation, each pushing its
whole closure with 16 parallel uploads).

| Measure | Value |
| --- | --- |
| Upload completions | 939 |
| Unique paths among them | 462 (so about 59% were repeats) |
| Unique paths: median NAR size | 106 KB |
| Unique paths under 1 MiB / under 64 MiB | 83% / 98% |
| Largest NAR | 379 MiB |
| Unique compressed bytes | 0.98 GB |
| Compressed bytes written, including repeats | 3.57 GB |
| Peak container instances (dashboard) | 480 |

Billing-period totals from the dashboard (October 16 to the time of the run,
so they include earlier usage and are an upper bound for this rebuild):

| Item | Usage | Workers Paid allowance |
| --- | --- | --- |
| Memory | 44.77k GiB-s (12.4 GiB-h) | 25 GiB-h |
| Disk | 358.13k GB-s (99.5 GB-h) | 200 GB-h |
| CPU | 3.2k vCPU-s (53 vCPU-min) | 375 vCPU-min |
| Egress | 5.04 GB | 500 GB (Oceania) |

Everything is inside the allowance; at list price the whole period would be
about $0.45. Cost is not urgent today. It becomes real with CI, more machines,
or larger rebuilds, and the current design is also slow.

What the numbers imply. These are inferences, not direct measurements:

- **The processor runs on `lite`.** Disk to memory is exactly 8 GB per GiB,
  which only `lite` (1/16 vCPU, 256 MiB, 2 GB) matches. The config sets no
  `instance_type`. That is about 50 container-hours in the period.
- **Most container time is idle.** Each upload job gets its own container
  (`getByName(job.job_id)` in `process-upload-workflow.ts`), and each container
  stays up for `inactivityTimeoutMs`, 2 minutes, after its last request.
  About 939 jobs times 2 minutes is roughly 31 of the 50 hours. At roughly 4
  uploads a second, 2 minutes of tail per upload gives about 480 live
  containers, which matches the peak.
- **Container writes to R2 are metered as egress.** The container has
  `enableInternet: false` and only reaches R2 through the intercepted
  `cache.r2` handler. The 3.57 GB of chunk writes fit under the 5.04 GB of
  egress; the 7.14 GB of reads (each staged upload is read twice) do not, so
  reads count as ingress. Writes through a Worker's R2 binding are not
  container egress.

## Goals

1. No container for a typical upload.
2. No container egress.
3. Never process the same path twice at the same time.
4. Upload only chunks the installation does not already have.
5. Do the CPU-heavy encoding on the client, which already reads every byte.

Non-goals: changing the serving path or the chunking and compression
parameters (`CHUNK_*_SIZE`, `ZSTD_LEVEL = 3`), unless a benchmark below says
otherwise.

## Stage 0: settings

Small, reversible, and measurable on the next rebuild.

- **Shorten the idle timeout.** With one container per job, a container is
  only reused by a retry of the same job, and step retries back off by at
  least 30 seconds, so the 2-minute tail buys almost nothing. Set
  `inactivityTimeoutMs` to something like 10 seconds. Revisit it if Stage 1c
  introduces a pool, where a warm container is useful.
- **Cap the number of instances.** Add a maximum instance count to the
  container config so no client can cause another spike like 480. To verify:
  the exact config key for the `durable_object` scheduling policy, and what a
  start beyond the cap returns. The workflow's step retries should absorb a
  temporary refusal.
- **Set `instance_type` explicitly.** Keep `lite` for now and record the
  choice in config, not by default. Revisit it with Stage 1c, or drop it if
  Stage 3 removes the container from the common path.

**Done when** the same rebuild shows container time close to actual
processing time and a peak no higher than the cap.

## Stage 1: stop repeated work

### 1a. Merge concurrent uploads of the same path on the server

Today upload allocation only deduplicates by idempotency key
(`upload-allocations.ts`). Two pushes that both see a path as missing create
two jobs, two workflows, and two containers.

- Track in-flight uploads per cache, keyed by store hash and NAR hash.
- `POST /api/caches/{cache}/missing` should report an in-flight path as not
  missing, or as a distinct `pending` state so the CLI can say so.
- Allocating an upload for a path that is already in flight with the same NAR
  hash should return the existing job instead of creating one.
- Only merge identical NAR hashes. A different NAR hash for the same store
  hash is a replacement and keeps today's behaviour.
- If the in-flight job fails, the next push must be able to start a new one.

This fixes repeats for every client: the hook, CI, and other machines.

### 1b. Queue the post-build hook

In the dotfiles, the hook should append `$OUT_PATHS` to a spool file and make
sure one drainer is running. The drainer takes everything in the spool and
runs a single `cf-nix-cache push` until the spool is empty. macOS has no
`flock`, so take the lock with `mkdir`. This caps one machine at 16 uploads at
a time and collapses overlapping closures into one push.

### 1c. Optional: a container pool

The processor is already an `axum` server that handles concurrent requests,
and the Durable Object already merges simultaneous starts. Choosing from a
fixed set of names (hash of the job ID, so retries land on the same
container) instead of `job.job_id` bounds containers at the pool size. This
needs a concurrency limit inside the processor, an instance larger than
`lite`, and acceptance that one crash fails every job on that container. Only
worth doing if Stage 3 is not.

**Done when** repeat uploads are close to zero and egress for a rebuild is
close to its unique compressed bytes (about 1 GB instead of 3.6 GB for the
measured run).

## Stage 2: small paths in a Worker (skip if doing Stage 3)

Run the existing pipeline compiled to wasm inside a Worker for NARs under a
size threshold (64 MiB covers 98% of the measured paths), and keep the
container for larger ones. The size is known when the upload is allocated, so
dispatch is simple.

This needs the processor's tokio and `spawn_blocking` structure reworked for a
single-threaded wasm runtime, and `zstd` built for wasm with the same library
version. It removes containers from most uploads but keeps the staging copy,
the second read, and one workflow per path. Stage 3 removes all of those.

## Stage 3: encode on the client

The CLI already runs `nix-store --dump` and compresses every path before
upload. It can run the same chunking and compression the processor runs
(FastCDC with `CHUNK_*_SIZE`, zstd level 3 per chunk) on much faster hardware,
and upload only what is missing. The server's job becomes checking, not
encoding.

### Flow

Names are illustrative.

1. **Path check.** `POST /api/caches/{cache}/missing`, as today.
2. **Encode locally.** For each missing path, the CLI produces the ordered
   chunk list: raw hash, raw size, compressed hash, and compressed size for
   each chunk, plus the NAR hash and size. It checks the NAR hash against
   `nix path-info` before sending anything.
3. **Open a session.** `POST /api/uploads` with the cache, `encoding_id`,
   narinfo metadata (references, deriver, CA, NAR hash and size), and the
   chunk list. The server:
   - takes a garbage-collection **upload lease** for the session, before it
     looks at any chunk;
   - reserves quota from the claimed sizes;
   - returns the chunks that are missing.
4. **Upload missing chunks.** `PUT /api/uploads/{session}/chunks/{raw_hash}`.
   The Worker streams the body through zstd decompression and SHA-256, checks
   the raw hash and the compressed hash against the session's chunk list, and
   only then writes the chunk to its final content-addressed key with the
   existing conditional write.
5. **Complete.** `POST /api/uploads/{session}/complete`. The server runs the
   checks chosen under [Verification](#verification), records the manifest,
   publishes through `PublicationProtocol`, reconciles quota, and releases the
   lease.

Paths smaller than `CHUNK_MIN_SIZE` are a single chunk, so steps 3 to 5 can be
one request. Several small paths can share one request to cut round trips;
most paths in the measured run were in this case.

### Why each piece is there

- **The lease is needed from step 3, not step 5.** An existing chunk can be
  unmarked and past its grace period. Reporting it as present and then having
  the sweep delete it before publication would publish a manifest with a
  missing chunk. This is the same race the current upload lease closes, and
  the same mechanism closes it. An abandoned session leaves unreferenced
  chunks, which the next collection removes after the grace period.
- **Check before writing to the final key.** Keys are content-addressed and
  writes are conditional, so the first writer wins permanently. A body that
  does not decode to its claimed raw hash must never reach the final key.
  That means buffering the compressed chunk (at most about 16 MiB) while it is
  checked. It fits in a Worker's 128 MB, but concurrent requests in one
  isolate share that memory, so the benchmark must cover several uploads at
  once. Writing to a staging key and copying would also work, but costs a
  second write and read.
- **Compressed bytes must match.** The narinfo `FileHash` covers the
  concatenated compressed chunks, and the server cannot recompute it without
  reading every chunk. Pin `encoding_id`, require the client's compressed
  hash for each chunk to match the stored object (checked on upload for new
  chunks, and from stored metadata for existing ones), and accept the
  client's `FileHash` only when every chunk matches. Otherwise reject the
  session, or fall back to the server path. Storing each chunk's compressed
  hash with the object is a prerequisite.

### Verification

Choose how much the server checks before publishing. This is a security
decision, not a performance detail.

| Level | Check | Cost |
| --- | --- | --- |
| L1 | Each uploaded chunk decodes to its raw hash | Cheap, at upload time |
| L2 | The NAR hash matches the concatenation of all chunks | Reads every chunk back from R2 (no egress through the binding) |
| L3 | The NAR is structurally valid, as the processor checks today | Same read as L2 plus parsing |

Only L2 ties the published NAR hash to the content. Without it a client could
publish a narinfo whose hash does not match. Nix would reject that path on
download, which fails safe, but the path stays broken until it is replaced.
Anyone with a push grant can already publish arbitrary valid content, so L2
and L3 protect against broken or buggy clients more than against malicious
ones.

Recommendation: always L1; L2 and L3 inline for NARs under a threshold; above
it, either run L2 and L3 across several Workflow steps with resumable SHA-256
and parser state, or fall back to the container. The threshold comes from
benchmark B1.

### Information leak

Chunks are shared across every cache, so "which of these chunks are
missing?" tells a push-token holder whether content exists anywhere in the
installation, not only in their cache. For a single-owner installation this
does not matter. For a shared one, either answer only relative to the
caller's caches, which loses cross-cache deduplication, or document it.

### Compatibility

Keep the current staging upload path while older CLIs exist, selected by a
new route or `encoding_id`. The container becomes the fallback for large NARs
and old clients, and can be removed once neither needs it.

## Benchmarks to run first

Stage 3 depends on numbers we do not have. Run these in a throwaway Worker on
real chunks from the cache before committing to it.

- **B1:** wasm zstd decompression plus SHA-256 in a deployed Worker: CPU ms
  per MiB on 16 MiB chunks, and memory with several concurrent requests. This
  sets the inline verification threshold. Workers do not, as far as we know,
  decompress zstd natively.
- **B2:** wasm NAR structural validation throughput, for L3.
- **B3:** cold-start and end-to-end time for a 100 KB path: current
  container versus Worker.
- **B4:** native CLI and processor produce byte-identical zstd frames for the
  same chunk, on aarch64-darwin, aarch64-linux, and x86_64-linux.
- **B5:** stock Nix behaviour if a narinfo omits `FileHash`. If Nix accepts
  it, the byte-identical requirement could be relaxed.

## Expected effect

Estimates from the measured run, not measurements:

| Stage | Container time | Container egress | Repeat uploads |
| --- | --- | --- | --- |
| Today | ~50 h per period, mostly idle | ~3.6 GB per rebuild | ~59% |
| 0 | Close to processing time | Unchanged | Unchanged |
| 1 | Lower again | ~1 GB per rebuild | ~0% |
| 3 | Only large NARs, if any | ~0 | ~0%, and only missing chunks are sent |

## What to watch

- Container GiB-s, GB-s, vCPU-s, and egress, per billing period and per
  rebuild.
- Peak live container instances.
- Workflow instances per uploaded path.
- Push time for a full rebuild, and p50 and p95 per-path upload time.
- Bytes uploaded compared with unique compressed bytes.

## Open questions

1. Verification level for Stage 3, and the inline threshold (after B1).
2. Whether to answer chunk-existence queries across caches.
3. The config key and behaviour for capping container instances.
4. Whether Nix accepts narinfo without `FileHash` (B5).
5. Whether to keep `lite` once Stage 1 lands, or move straight to Stage 3.

## Implementation

What was built, and where it departs from the plan above.

**Stage 0.** The `durable_object` scheduling policy supports neither
`max_instances` nor `instance_type`
([Cloudflare docs](https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-scheduling-policy/)):
running containers only count toward account limits, and the size is the
`instance` option of `ctx.container.start()`. So the size is set there
(`lite`), and the cap is enforced in code: jobs go to one of 16 containers by a
hash of the job ID, which is the light form of 1c. Each processor runs one job
at a time (`MAX_CONCURRENT_JOBS`), the rest queue in its HTTP server, and the
idle timeout is 10 seconds. A workflow step that queues behind other jobs has a
30-minute timeout. This answers open question 3.

**Stage 1a.** The cache coordinator keeps `inflight_uploads` (store hash, NAR
hash, upload ID). `missing` reports in-flight paths in a new `pending` list with
their upload IDs, and the CLI waits for those, uploading a path itself only if
the other upload fails. Allocation returns the in-flight upload of the same NAR
hash (`merged`). An entry ends when its upload reaches a terminal state, is
replaced when an allocation finds its upload FAILED or ABORTED, and expires
after an hour. A staging upload from an older CLI joins only an upload past
`UPLOADING`, because such a client would send its own parts into it.

**Stage 1b.** In the dotfiles, the post-build hook appends `$OUT_PATHS` to
`/var/lib/cf-nix-cache/queue` and starts a drainer. The drainer takes a lock
with `mkdir` (`/var/run`, emptied at boot, plus a PID check for a drainer that
died), moves the queue aside, and runs one push for all of its paths until the
queue stays empty.

**Stage 3.** As in the flow above, with these changes:

- The server builds the manifest from the stored chunks during verification
  (L2), so `FileHash` is always the hash of what is served. The client's
  compressed hashes are checked for chunks it uploads (L1) but are not trusted
  for anything else, so the byte-identical requirement, per-chunk compressed
  hash metadata, B4 and B5 stopped being prerequisites.
- Verification (open question 1): always L1; L2 and L3 inline for NARs up to
  256 MiB (`INLINE_VERIFY_MAX_NAR_SIZE`, from B1); above it the processor
  workflow verifies the stored chunks (`chunks_key` in the process job) and
  writes only the manifest. The container reads chunks but writes no chunks,
  so this path has no chunk egress.
- An upload whose NAR already has a manifest needs no chunks and no
  verification, as in the processor's own deduplication.
- Quota: opening an upload only checks that the claimed size fits; publication
  still reserves through `PublicationProtocol`. Reserving at open would
  double-count against the publication's own reservation.
- Chunk existence is answered across the installation (open question 2), and
  documented in the README.
- Small paths, under `CHUNK_MIN_SIZE`, are opened 32 to a request and
  completed in a second request that carries their missing chunks.
- `push --staging-upload` keeps the old path, and the CLI falls back to it on a
  server without the new routes or when the server rejects its encoding.

The upload state lives in the existing `UploadJob` Durable Object (new
`session` and `session_chunks` tables), so no Wrangler migration is needed.

While measuring, two latency problems unrelated to the plan came up and were
fixed: `missing` looked paths up one index shard at a time (8 s for 20 paths),
and publication re-read the manifest it had just written and waited for the
staging cleanup.

## Results

Measured on 2026-11-08 against a throwaway installation built from this branch,
from a client in Oceania (about 370 ms to the `SIN` colo), with real store
paths. CPU times are Workers `cpuTime` from `wrangler tail`.

| Benchmark | Result |
| --- | --- |
| B1: decode plus SHA-256 of raw and compressed bytes, in a deployed Worker (`fzstd`, pure JavaScript) | 15 to 35 ms per raw MiB for compressible chunks (about 10:1), 3 to 4 ms per MiB for incompressible ones |
| B1: memory | 8 and 16 concurrent requests on 6 to 13 MiB chunks all succeeded |
| B2: NAR structural validation | about 30 ms per MiB for a NAR of many small files (TeX), negligible for one large file |
| L2 and L3 together, whole NAR | 570 ms CPU for a 20 MB NAR of many files, 827 ms for a 108 MB one |
| B3: one 100 KB path, end to end | staging upload with a cold container 21 s; client-encoded 7 s, with no container |
| B4: CLI on aarch64-darwin against the processor on x86_64-linux | identical chunk boundaries and byte-identical frames on two real NARs; aarch64-linux not tested |
| B5 | not run; no longer needed, as above |

End-to-end pushes after the fixes above:

| Push | Staging upload | Client-encoded |
| --- | --- | --- |
| 20 fresh paths of 30 to 400 KB | 23.0 s | 11.6 s |
| One 21 MB path | 14.2 s | 10.2 s (inline verification) |
| One 105 to 108 MB path | 78 s | 71 s (processor verification; both limited by upload bandwidth) |
| 20 paths already cached | | 2.7 s |

Two concurrent pushes of the same 8 fresh paths uploaded each once: the second
reported all 8 as already being uploaded and waited for them.

Not measured yet: container time and egress for a full system rebuild, which is
the test of "Done when" for each stage. Watch the numbers under
[What to watch](#what-to-watch) on the next rebuild after deploying. With the
current CLI, a rebuild should start no containers unless it has NARs over
256 MiB.

