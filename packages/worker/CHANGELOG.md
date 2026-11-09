# cf-nix-cache

## 0.8.0

### Minor Changes

- c11c17b: Add a GitHub Action that installs Determinate Nix with the cache as a substituter and pushes each path as soon as it is built, so a failed job still caches what it finished. It is backed by the new `cf-nix-cache watch` command, and releases now include standalone CLI binaries for x86_64-linux, aarch64-linux and aarch64-darwin, which the action downloads.

## 0.7.0

### Minor Changes

- a1119c0: Harden the deployment template and centralize durable storage access. Template configuration now uses tested loaders with schema enforcement, `doctor` diagnoses deployments, and deploy/preview/rotation helpers align with Worker verification. Durable Objects share a typed SQLite toolkit (`shared/sql.ts`) with row readers, JSON columns, keyset pagination, and transactional migrations, and the upload lifecycle is pinned as an explicit state machine with transition assertions.
- a1119c0: Verify large uploads in the Worker. NARs over 256 MiB are now checked in a `ProcessUploadWorkflow` step by a WebAssembly verifier (the C zstd library plus NAR structural validation, with native SHA-256) instead of a processor container: about 66 s of CPU at worst for a 10 GiB NAR, and no container time or egress. The processor container, its Docker image, and the `ProcessorContainer` and `ObjectStoreProxy` exports are gone. Deployments must update `wrangler.jsonc`: remove the `containers` section and the `PROCESSOR` Durable Object binding, add a migration with `"deleted_classes": ["ProcessorContainer"]` (the template uses tag `v3`), and set `"limits": { "cpu_ms": 300000 }`. A `cpu_ms` above 30 s needs the Workers Paid plan. `release-manifest.json` is now `schemaVersion` 2 and contains only `schemaVersion`, `releaseReady`, and `version`.

## 0.6.0

### Minor Changes

- 8173f80: Make pushes cheaper and faster. The CLI now chunks and compresses each NAR itself and uploads only the chunks the installation lacks, and the Worker verifies them and publishes the path without a staging copy or, for NARs up to 256 MiB, a processor container. Concurrent pushes of the same path share one upload, and `missing` reports paths another push is uploading as `pending`. Processor containers are now `lite` instances drawn from a pool of 16 that stop after 10 idle seconds, and `missing` looks paths up in parallel. The whole-NAR staging upload is removed: CLIs from before client encoding are told to upgrade, and an unfinished staging upload is marked FAILED. No `wrangler.jsonc` changes are needed.

## 0.5.1

### Patch Changes

- 2c89c9a: Fix an issue where deployments failed due to incorrect schedules in wrangler.jsonc

## 0.5.0

### Minor Changes

- afa36c3: Fix upload and deletion recovery, and stop storing bearer tokens. A publish retry no longer conflicts with its own earlier attempt, a stopped workflow is now restarted, and lock contention or a dropped connection to R2 no longer fails an upload permanently. An interrupted cache creation no longer breaks `GET /api/caches`, and that cache can now be deleted. Replaying a token request now signs the token again from stored metadata and refuses revoked tokens, and tokens stored by earlier releases are cleared. API errors from a publication now carry their original code and status instead of `retryable_failure`. CLI: `cache configure` now requires `--public` or `--public=false` rather than silently making a cache private, `bootstrap --help` no longer prints the secret, and `--output json` prints the server's response unchanged. The Rust binaries and new manifests now report the release version, and the crates are correctly licensed MIT.

## 0.4.0

### Minor Changes

- 81a235f: Add automatic garbage collection. A weekly run now deletes manifests and chunks that no cache references, including those left behind by deleted paths and caches. Caches keep paths indefinitely unless you opt in with `cf-nix-cache cache retention <cache> <days>`, which evicts paths not used for that many days. Use `cf-nix-cache gc run --dry-run` to preview a run and `cf-nix-cache gc status` to see the last result. Uploads wait briefly while a run deletes objects. **Upgrading requires changes to `wrangler.jsonc`:** add the `GC_CONTROL` Durable Object binding, a `v2` migration with `new_sqlite_classes: ["GcControl"]`, the `garbage-collect` workflow, and `limits.subrequests`. See the template's `wrangler.jsonc`. Deploys fail with a clear error until the binding and workflow are present.
- 81a235f: `cf-nix-cache push` now skips paths signed by a cache's upstream caches, so clients fetch them from there instead. Every cache, including existing ones, starts with `cache.nixos.org-1` as its upstream. **If your clients don't use cache.nixos.org, run `cf-nix-cache cache upstreams <cache> --none` after upgrading**, or their closures will have gaps. Set other upstreams with `cf-nix-cache cache upstreams <cache> <key-name>...` or `cache create --upstream-cache-key-name`, and upload everything for one push with `--ignore-upstream-cache-filter`.

### Patch Changes

- 81a235f: Fix cache deletion leaving most of a cache's index behind. It cleared 225 of the 1024 index shards, so the rest kept their rows in Durable Object storage permanently. Those rows were never served. Deletion now clears every shard, and takes longer as a result. Rows left by earlier deletions are not recovered.

## 0.3.1

### Patch Changes

- 5b8c33d: Fix cache deletion, which always failed with HTTP 500 on Cloudflare because its Workflow instance ID contained a colon. A cache left in `DELETING` finishes when the delete is retried. Log the error stack for unhandled errors, which previously appeared as `{}`.

## 0.3.0

### Minor Changes

- 0832e86: `cf-nix-cache push` now uploads store paths concurrently, 16 at a time by default (set with `--jobs`). A failed path no longer stops the rest of the push: the remaining paths still upload, each failure is reported, and the command exits non-zero.
- cd62388: Re-arm bootstrap by setting a new `BOOTSTRAP_SECRET_HASH`, so a lost or expired admin token is recoverable. Each secret still works only once, and the secret configured when upgrading is treated as used. Raise the maximum token lifetime from 5 years to 200 years.

## 0.2.1

### Patch Changes

- 152c829: Bundle hono 4.13.16 and jose 6.2.14, and update development tooling.

## 0.2.0

### Minor Changes

- 7d31bb8: Run the processor Container under the `durable_object` scheduling policy, which
  accounts that cannot create `default`-policy Container applications require.
  `ProcessorContainer` now starts its own container from the `processor` image in
  `ctx.container.images` instead of using `@cloudflare/containers`, and the
  `ContainerProxy` export is replaced by `ObjectStoreProxy`. Deployments must
  switch `wrangler.jsonc` to `scheduling_policy: "durable_object"` with an
  `images.processor` Dockerfile, and `max_instances` is no longer supported. The
  scheduling policy cannot be changed in place, so an existing deployment gets a
  new Container application.

## 0.1.3

### Patch Changes

- 8c58909: Repair the Release PR workflow for Changesets v3 compatibility.

## 0.1.2

### Patch Changes

- 2f985f4: Bundle hono 4.13.14, which fixes the hono security advisories affecting the Worker runtime.

## 0.1.1

### Patch Changes

- 8d1de6d: Fix the deployment template and several Worker error paths.

  - Template: the rendered deploy config now resolves `main` correctly, the
    deployed workers.dev URL (or `CF_NIX_CACHE_URL`) is used for health checks
    and printed configuration, a failed `wrangler secret list` can no longer
    trigger key regeneration, R2 bucket checks match the exact bucket name, and
    Dependabot uses the `npm` ecosystem.
  - Worker: invalid upload completion bodies return 422 instead of 500, an
    upload whose cache was removed now fails terminally instead of retrying
    forever, audit delivery failures are retried by alarm, and Nix error
    responses carry `cache-control: no-store`.
  - Package: `index.d.ts` now declares the default handler and every exported
    Durable Object and Workflow class.
