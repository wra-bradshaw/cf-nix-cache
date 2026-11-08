# cf-nix-cache Cloudflare template

<!-- Deploy button metadata: keep this URL pointed at the public template repository. -->

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wra-bradshaw/cf-nix-cache-template)

This repository is the supported customer deployment surface for cf-nix-cache.
Cloudflare clones it into your GitHub repository and Workers Builds runs the
same `pnpm run deploy` command that can be used from GitHub Actions, GitLab CI,
Jenkins, or another runner. The repository contains no application source of
its own.

## First deployment

This application requires the Workers Paid plan, and the account must have R2
enabled. The upload workflow verifies each NAR inside the Worker, which needs
the higher CPU limit (`limits.cpu_ms` in `wrangler.jsonc`) that only Workers
Paid allows.

1. Click **Deploy to Cloudflare**, choose the account and destination
   repository, and keep Workers Builds enabled.
2. In the build's secret variables, set one value named
   `CF_NIX_CACHE_BOOTSTRAP_SECRET`. Use a random value of at least 32
   characters. It is hashed in memory and is never committed or passed as a
   command-line argument.
3. Review `wrangler.jsonc` and edit the Worker name, R2 bucket name,
   placement, routes, and observability to suit the account. The
   `CACHE_BUCKET` binding is the supported cache bucket. The helper creates
   it if it does not exist and applies the staging lifecycle rule.
4. Trigger the build. The first run deploys the Worker and bindings, creates
   authentication and Nix Ed25519 keys in memory, uploads the five required
   Worker secrets in one bulk operation, applies lifecycle rules, redeploys,
   and checks `/health`.

The build log prints the workers.dev URL, public Nix key, a bootstrap command,
and the Nix configuration. It never prints a private key or the bootstrap
secret. Run the printed command once to mint the first one-year admin token.
Bootstrap is idempotent for its idempotency key, and each secret works once.
See [Recovering admin access](#recovering-admin-access) to mint another token.

If the account uses a custom hostname, add a route in `wrangler.jsonc` and set
`CF_NIX_CACHE_URL` in CI so health checks and the generated command use that
hostname. The first deployment intentionally uses workers.dev by default.

## Configuration and upgrades

`wrangler.jsonc` is customer-owned. Keep changes to names, placement, routes,
and observability there. Do not copy upstream application source into
this repository. Upgrade the pinned dependency with Dependabot or Renovate:

```console
pnpm update cf-nix-cache --latest
pnpm run deploy
```

The helper deploys `wrangler.jsonc` exactly as committed. Before deploying it
validates the config and checks that the installed package's
`release-manifest.json` uses a schema this template understands; a mismatch
means the template and the `cf-nix-cache` package must be upgraded together.

`pnpm run preview` uploads a Worker version without sending production traffic
to it; `pnpm run deploy` deploys to production.
The same command is suitable for Workers Builds and external CI; it requires
the normal Wrangler credentials (`CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`, or an equivalent Wrangler login). R2 lifecycle rules
are applied through Wrangler, so the logged-in profile works for external CI
as well.

## Operations

```console
pnpm run doctor
pnpm run rotate-auth-key
pnpm run rotate-nix-key
```

Always invoke the helpers through `pnpm run`: `pnpm setup`, `pnpm deploy`, and
`pnpm doctor` are pnpm built-in commands and do not run this repository's
scripts.

`doctor` checks package compatibility, the complete secret set, the R2 bucket
and lifecycle configuration, leftover configuration from older template
releases, and observability. It also fails when the installed package version
differs from its release manifest version; `pnpm run check` and deploys
already reject a manifest schema this template does not understand, so that
doctor check only catches a partially installed package. A partial secret set
always fails:
the helper never silently regenerates keys. Authentication rotation invalidates
all existing capability tokens, so re-arm bootstrap afterwards to mint a new
admin token. Nix-key rotation invalidates existing narinfo
signatures, so publish the new public key to every client before rotating.
The generated Nix substituter is `https://<worker>/cache/<cache-name>` after
you create a cache with the admin token.

### Recovering admin access

If the admin token is lost or expired, or after an authentication rotation, set
a new secret to re-arm bootstrap. A secret that has already been used stays
rejected with HTTP 409, even if you set it again.

```console
read -rs CF_NIX_CACHE_BOOTSTRAP_SECRET; export CF_NIX_CACHE_BOOTSTRAP_SECRET
printf '%s' "$CF_NIX_CACHE_BOOTSTRAP_SECRET" \
  | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=' \
  | pnpm exec wrangler secret put BOOTSTRAP_SECRET_HASH
```

Then run the bootstrap command from the build log again. Re-arming does not
revoke existing tokens, so revoke a lost token with `DELETE /api/tokens/{jti}`.
Requests may set `valid_for_seconds` up to 6311520000 (200 years).

The first request after upgrading from a release without re-arming treats the
secret configured at that moment as used. If bootstrap returns 409 after
upgrading and setting a new secret together, set another new secret.

Garbage collection needs configuration that older deployments lack. When
upgrading from a release without it, copy these from this template's
`wrangler.jsonc` to yours: the `GC_CONTROL` binding, the `v2` migration, the
`garbage-collect` workflow, and `limits`. Deploys fail until the binding and
workflow are present. The first scheduled run deletes objects left unreferenced
by earlier path and cache deletions; preview it with `cf-nix-cache gc run --dry-run`.

### Upgrading from a release with the processor container

Earlier releases verified large uploads in a Cloudflare Container. Uploads are
now verified inside the Worker, and the `cf-nix-cache` package no longer
exports `ProcessorContainer`. Take these `wrangler.jsonc` changes from this
template in the same change that upgrades the package:

- remove the `containers` section and the `PROCESSOR` Durable Object binding;
- keep `ProcessorContainer` in the `v1` migration and append the `v3`
  migration, `{ "tag": "v3", "deleted_classes": ["ProcessorContainer"] }`;
- add `"cpu_ms": 300000` to `limits`.

The `v3` migration deletes the old class, which held no durable data. You can
also delete `Dockerfile` and any `CF_NIX_CACHE_PROCESSOR_IMAGE` setting. Deploy,
preview, `pnpm run check` and `doctor` report a config that still needs these
changes.

Deleting the Worker does not delete a non-empty R2 bucket. To tear down a
cache, first stop writers, verify the bucket is empty, explicitly delete its
objects, and then remove the bucket using Wrangler. This is intentionally not
part of `pnpm run deploy` or `pnpm run doctor`.

## Required secret names

Only the bootstrap value is supplied to the Deploy button. The helper creates
these Worker secrets and keeps private values out of Git, logs, and command
arguments:

`AUTH_PRIVATE_JWK`, `AUTH_PUBLIC_JWKS`, `NIX_PRIVATE_JWK`, `NIX_PUBLIC_KEYS`,
and `BOOTSTRAP_SECRET_HASH`.

See [TESTING.md](TESTING.md) for the clean-account acceptance matrix,
including a real `nix copy`, rollback, preview, external-CI, and teardown
checks.
