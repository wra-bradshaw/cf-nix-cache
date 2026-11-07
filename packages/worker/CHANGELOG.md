# cf-nix-cache

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
