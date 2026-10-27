# cf-nix-cache

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
