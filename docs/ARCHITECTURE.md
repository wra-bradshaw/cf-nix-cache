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
                                      └─ Durable Object / processor adapters
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

Publication, replacement, direct deletion, and cache teardown all use the
same `PublicationApplication`: `prepare(operation_id) -> reserve(operation_id)
-> commit(operation_id) -> finalize(operation_id)`. Prepare locks the store
hash and records the exact delta. Quota reservations include pending positive
deltas. Every operation is safe to repeat after a restart; an uncommitted
reservation is aborted and a committed index mutation retains its pending
charge until finalization. Cache teardown first fences every index shard and
aborts prepared mutations, preventing a publication already in flight from
recreating paths after the shard is cleared. Already-reserved publications
are reconciled and finalized during deletion before their shard delta is
applied, so a response loss cannot strand teardown. There is no live-object
eviction or manifest/chunk garbage-collection workflow for infrastructure
failures; R2 lifecycle rules clean abandoned staging data. Because a path can
be replaced, public NAR responses use a bounded cache lifetime rather than an
immutable year-long cache directive.

The processor is split into HTTP bootstrap, processing service, NAR
validation, chunking/compression, and an injected object-store adapter. It
performs a validation pass before the permanent content-addressed write pass,
so malformed input cannot leave chunks behind. Invalid input is a permanent
422; object-store and other infrastructure failures are retryable 503
responses. The Container accesses `CACHE_BUCKET` through the
Worker's `cache.r2` `outboundByHost` handler, so the same binding targets local
Miniflare R2 under `wrangler dev` and deployed R2 in production.
Content-addressed writes are conditional.

The CLI has command definitions, capability handlers, and a retrying API
client. Outbound JSON bodies are built directly as the Rust DTOs generated
from the API schemas. Each CLI invocation creates a fresh
idempotency key that the retry middleware reuses for transient failures, and
uses the same `/api` routes as the documented API. Request and response
schemas are generated for both Worker and Rust contract tooling; domain types
remain separate where they add semantic validation or application policy.
## Worker structure

The worker is organized by feature first. `src/features` owns the application
surface, with each feature keeping its routes, use cases, domain rules, and
feature-specific helpers together. Runtime composition lives in
`features/runtime`; Durable Object entrypoints remain infrastructure adapters
and are exported through the stable `src/durable.ts` registry.

Pure rules are kept behind the domain and application boundaries and may not
import Cloudflare or other infrastructure adapters. The boundary check is
part of the worker check command.

Unit tests live beside their implementation as `<module>.test.ts`. End-to-end
tests keep the Vitest file focused on lifecycle and scenario declarations;
harness setup, HTTP assertions, process utilities, and scenario implementations
are split under `e2e/support` and `e2e/scenarios`.

The Rust crates are small, so each uses a flat module layout. `core/src`
owns shared protocol semantics (`identifiers`, `manifests`, `wire`, `error`).
The processor splits into `main` (HTTP bootstrap), `service` (processing),
`nar` (NAR validation), and `object_store` (storage adapter). The CLI splits
into `args` (command definitions), `handlers` (command flows), `nix` and
`upload` (local Nix and multipart upload helpers), `client` (HTTP client),
and `config` (credential storage).
