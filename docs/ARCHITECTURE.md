# Architecture

The Worker entry point is transport and composition wiring. Transport parses
contract DTOs and authenticates requests; application workflows coordinate
ports; domain validation and state transitions are independent of Cloudflare,
SQL, HTTP, R2, AWS, and CLI adapters. The checked-in JSON Schemas are the wire
contract source, with generated Rust DTOs in `crates/contracts` and generated
Worker validators in `packages/worker/src/generated`.

```text
stock Nix / CLI
      │ HTTPS / current API DTOs
      ▼
transport ──► application use cases ──► typed ports
                                      ├─ CacheIndex / prepare-commit protocol
                                      ├─ QuotaLedger / reservation protocol
                                      └─ Durable Object / Workflow adapters
```

Durable Objects are adapters and authorities for mutable state. Cache
catalogues persist `CREATING`, `ACTIVE`, and `DELETING`; a failed lifecycle
step leaves the saga resumable. A later create request for the same name can
resume an interrupted `CREATING` record, but its public/quota/encoding
configuration is fenced to the original request. Upload jobs reconcile
workflow creation from every non-terminal processing state and classify
permanent publication errors as terminal. Token issuance and revocation are
idempotent and listed from a paginated low-volume catalog. Audit events are
keyed by operation ID, distributed across fixed Durable Object shards, and
merged behind the same timestamp/id cursor; a cache cannot be removed until
its coordinator outbox has been delivered. Cache-name-to-incarnation lookups
use a short-lived Worker Cache API hint and carry the catalogue lifecycle
through routing; the coordinator remains the serving authority, so catalog
traffic is reduced without allowing a CREATING or DELETING transition to serve
data. Global control-plane operations require a wildcard admin grant.

Publication, replacement, and direct deletion all use the same
`PublicationProtocol`: `prepare(operation_id) -> reserve(operation_id)
-> commit(operation_id) -> finalize(operation_id)`. Prepare locks the store
hash and records the exact delta. Quota reservations include pending positive
deltas. Every operation is safe to repeat after a restart; an uncommitted
reservation is aborted and a committed index mutation retains its pending
charge until finalization. Cache teardown does not go through that protocol:
`DeleteCacheWorkflow` calls the shard's `clear` and the coordinator's
`reconcile` and `clearDelta` directly, once per shard. Clearing first fences
the index shard and aborts prepared mutations, preventing a publication already
in flight from recreating paths after the shard is cleared. Already-reserved
publications are reconciled and finalized during deletion before their shard
delta is applied, so a response loss cannot strand teardown. R2 lifecycle rules clean
abandoned staging data, and garbage collection (below) reclaims manifests and
chunks. Because a path can be replaced, public NAR responses use a bounded cache lifetime rather than an
immutable year-long cache directive.

Uploads are encoded by the CLI, which already reads every byte of the NAR: it
splits it with FastCDC, compresses each chunk as its own zstd frame, and sends
only the chunks the bucket lacks. The server never encodes. The upload's
`UploadJob` Durable Object keeps the chunk list and a garbage collection lease,
taken before it looks for existing chunks (see below). A chunk is decoded and
hashed against its claim before it is written to its content-addressed key,
because the first writer of a key wins for good (verification level 1).
Completion reads the stored chunks back and checks that they concatenate to a
structurally valid NAR with the declared hash (levels 2 and 3); the manifest,
and so the narinfo `FileHash`, is built from the stored bytes, whichever zstd
build wrote them. NARs up to 256 MiB are checked in the completing Worker
request, which benchmarks put at well under the 30-second CPU limit; larger ones
go to the `ProcessUploadWorkflow`, which runs the same checks in one step,
reads the same chunks, and writes only the manifest. The chunk list is written before publication, so a completion
interrupted while publishing is finished by the workflow from the chunks
already in the bucket: a retryable failure enqueues it immediately, and a later
state poll or push enqueues it if the request died without a response. The
client never re-sends the NAR.

The cache coordinator tracks each path's in-flight upload by store hash and
NAR hash, so concurrent pushes of a path join one upload instead of processing
it twice. Entries end when the upload does, and expire after an hour.

Both paths verify with `crates/verify`, compiled to WebAssembly and bundled
with the Worker: it decodes each chunk with the C zstd library and validates
the NAR structure as the chunks stream past, while the Worker hashes raw and
compressed bytes with native `crypto.subtle`, since WebAssembly has no SHA
instructions. Verification writes nothing but the manifest, so rejected input
leaves nothing behind. Invalid content fails the workflow permanently; R2 and
other infrastructure failures are retried by the step. The step's CPU budget
is `limits.cpu_ms` (300000, which needs Workers Paid), since Workflow steps
run under the Worker's configured CPU limit ([Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/));
at a measured worst case
of about 6.4 ms per MiB, a 10 GiB NAR is roughly extrapolated as ~66 s
(linear extrapolation from that rate, about ~6.6 s at 1 GiB; neither is a
measured bound; see
[COST_PLAN.md](COST_PLAN.md#results)). Content-addressed writes are
conditional.

The CLI has command definitions, capability handlers, and a retrying API
client. Outbound JSON bodies are built directly as the Rust DTOs generated
from the API schemas. Each CLI invocation creates a fresh
idempotency key that the retry middleware reuses for transient failures, and
uses the same `/api` routes as the documented API. Request and response
schemas are generated for both Worker and Rust contract tooling; domain types
remain separate where they add semantic validation or application policy.

## Garbage collection

Deleting a path or a cache only removes index rows. Manifests and chunks are
shared by content across every cache, so nothing can tell locally that an
object has become unused. `GarbageCollectWorkflow` finds this out with
installation-wide mark-and-sweep, weekly by default:

1. **Evict.** Caches with `retention_days` set drop paths not used for that
   long, through the normal publication protocol. Use means a narinfo request,
   a NAR request, or a push that finds the path already present. A path's
   references are not considered, so a retained path can outlive a dependency;
   Nix then builds or fetches that dependency elsewhere.
2. **Mark.** Walk all 1024 index shards of every live cache, then read each
   referenced manifest to mark its chunks. Marks live in the `GcControl`
   Durable Object, because they can outgrow a Worker's memory.
3. **List.** List the bucket, keeping unmarked objects older than the grace
   period as candidates. Uploads continue throughout steps 1-3, and a run with
   no candidates ends here without ever delaying one.
4. **Drain.** Close the upload gate and wait for active uploads to finish.
5. **Sweep.** Mark the manifests those uploads published, then delete the
   remaining candidates, manifests before chunks. Then reopen the gate.

An object's age cannot show that deleting it is safe, because conditional
writes deduplicate: an old unreferenced chunk can become referenced
by a new upload with no write to it, and an existing manifest is taken as proof
that its chunks exist. Upload leases close that race. An upload holds a lease
from before processing until after publication, and records its manifest before
publishing, so the run marks it even if the walk has passed that shard. Deletion
requires a closed gate and no live leases. A lease that expires is fenced at
publication, and that upload is processed again.

Failures stop before deleting. Any error while marking fails the run, as does a
manifest that exists but cannot be parsed. A run must keep calling in to the
ledger or it loses the gate, so a dead run blocks uploads for at most 30 minutes.
Every step is idempotent, and deleting manifests first means an interrupted
sweep cannot leave a manifest whose chunks are gone.

## Durable Object migrations

Durable Object classes are declared in `wrangler.jsonc` (`exports` at the top
level, `migrations` in the template's copy). The policy is append-only: never
edit a past migration, add a new tagged migration for every class change, and
remove a class with `deleted_classes` rather than by deleting its entry. A
removed class must hold no durable data worth keeping; `ProcessorContainer`
was removed this way once verification moved into the Worker. The template
refuses to deploy a config whose migrations do not delete the removed classes
it knows about, so an old deployment cannot silently keep a stale class.

## Worker structure

The worker is organized by feature first. `src/index.ts` is the entrypoint and
exports the Durable Object and Workflow classes directly from their feature
modules. `src/app` composes the Hono application and renders errors.
`src/features` owns the application surface, with each feature keeping its
routes, use cases, types, and helpers together; Durable Object classes live in
`features/*/durable` as thin RPC surfaces over helper classes that own the
SQL. `src/shared` is the small cross-feature kernel for errors,
identifiers, cursors, schema parsing, HTTP helpers, and RPC, SQL and Workflow
helpers. `shared/sql.ts` owns row access: `text`, `integer` and `json` read
typed columns and throw on null or mistyped values, and `collectPages` and
`pageCursor` cover cursor pagination. Upload state changes go through
`UploadStorage`, which asserts every transition against an explicit table, so
an illegal move throws instead of stranding an upload.

Dependencies point one way: `app` may import `features`, and `features` may
import `shared` and each other, but `shared` may not import `features` or `app`
and `features` may not import `app`. Pure modules (most of `shared`, each
feature's `types.ts`, `auth/authorization`, `cache/publication-protocol`,
`cache/shards`, `gc/garbage-collection`,
`gc/gc-ports`, and `uploads/manifest`) may import only other pure modules or
generated contracts, and may not use Cloudflare or other infrastructure APIs.
`packages/worker/scripts/check-boundaries.mts` enforces this as part of the
worker check command.

Unit tests live beside their implementation as `<module>.test.ts`. End-to-end
tests keep the Vitest file focused on lifecycle and scenario declarations;
harness setup, HTTP assertions, process utilities, and scenario implementations
are split under `e2e/support` and `e2e/scenarios`.

The Rust crates are small, so their module layouts stay nearly flat. The CLI
owns shared protocol semantics in `protocol` (`identifiers` and `wire`;
request DTOs are schema-generated in `contracts`). `verify` has a streaming
NAR validator (`nar`) and the WebAssembly calling convention the Worker uses
(`ffi`). The CLI splits
into `args` (command definitions), `commands` (dispatch, with `admin`, `gc`,
`push`, and `configure_nix` command flows), `nix` and `upload` (local Nix and
shared upload helpers), `encode` and `encoded_upload` (client-side chunking
and the upload flow), `client` (HTTP client), and `config`
(credential storage).
