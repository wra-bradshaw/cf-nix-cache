# cf-nix-cache

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
