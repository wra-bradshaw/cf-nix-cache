# cf-nix-cache Cloudflare template

<!-- Deploy button metadata: keep this URL pointed at the public template repository. -->

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wra-bradshaw/cf-nix-cache-template)

This repository is the supported customer deployment surface for cf-nix-cache.
Cloudflare clones it into your GitHub repository and Workers Builds runs the
same `pnpm deploy` command that can be used from GitHub Actions, GitLab CI,
Jenkins, or another runner. The repository contains no Rust source and never
builds a processor image.

## First deployment

This application requires the Workers Paid plan because it uses Containers,
and the account must have R2 enabled. The template itself does not require
Docker: it deploys the public, pre-built processor image pinned by the Worker
package's release manifest.

1. Click **Deploy to Cloudflare**, choose the account and destination
   repository, and keep Workers Builds enabled.
2. In the build's secret variables, set one value named
   `CF_NIX_CACHE_BOOTSTRAP_SECRET`. Use a random value of at least 32
   characters. It is hashed in memory and is never committed or passed as a
   command-line argument.
3. Review `wrangler.jsonc` and edit the Worker name, R2 bucket name,
   `max_instances`, placement, routes, and observability to suit the account.
   The `CACHE_BUCKET` binding is the supported cache bucket. The helper creates
   it if it does not exist and applies the staging/multipart lifecycle rules.
4. Trigger the build. The first run deploys the Worker and bindings, creates
   authentication and Nix Ed25519 keys in memory, uploads the five required
   Worker secrets in one bulk operation, applies lifecycle rules, redeploys,
   and checks `/health`.

The build log prints the workers.dev URL, public Nix key, a bootstrap command,
and the Nix configuration. It never prints a private key or the bootstrap
secret. Run the printed command once to mint the first one-year admin token.
Bootstrap is idempotent for its idempotency key and is rejected after it has
been consumed.

If the account uses a custom hostname, add a route in `wrangler.jsonc` and set
`CF_NIX_CACHE_URL` in CI so health checks and the generated command use that
hostname. The first deployment intentionally uses workers.dev by default.

## Configuration and upgrades

`wrangler.jsonc` is customer-owned. Keep changes to names, scaling, placement,
routes, and observability there. Do not copy upstream application source into
this repository. Upgrade the pinned dependency with Dependabot or Renovate:

```console
pnpm update cf-nix-cache --latest
pnpm deploy
```

The package's `release-manifest.json` supplies the matching immutable
`linux/amd64` processor image digest. The helper renders a temporary Wrangler
config that changes only `ProcessorContainer.image`; all other customer
configuration remains untouched. You may set
`CF_NIX_CACHE_PROCESSOR_IMAGE` to an immutable digest in a private mirror when
required. Mutable tags such as `latest` are rejected.

Preview deployments upload a Worker version and do not roll out the
production Container; use `pnpm preview` for that path. A production
`pnpm deploy` applies the Container rollout.
The same command is suitable for Workers Builds and external CI; it requires
the normal Wrangler credentials (`CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`, or an equivalent Wrangler login). R2 lifecycle rules
are applied through Wrangler, so the logged-in profile works for external CI
as well.

## Operations

```console
pnpm doctor
pnpm run rotate-auth-key
pnpm run rotate-nix-key
```

`doctor` checks package/image compatibility, the complete secret set, the R2
binding and lifecycle configuration, Durable Object and Workflow bindings,
Container configuration, and observability. A partial secret set always fails:
the helper never silently regenerates keys. Authentication rotation invalidates
all existing capability tokens. Nix-key rotation invalidates existing narinfo
signatures, so publish the new public key to every client before rotating.
The generated Nix substituter is `https://<worker>/cache/<cache-name>` after
you create a cache with the admin token.

Deleting the Worker does not delete a non-empty R2 bucket. To tear down a
cache, first stop writers, verify the bucket is empty, explicitly delete its
objects, and then remove the bucket using Wrangler. This is intentionally not
part of `pnpm deploy` or `pnpm doctor`.

## Required secret names

Only the bootstrap value is supplied to the Deploy button. The helper creates
these Worker secrets and keeps private values out of Git, logs, command
arguments, and Terraform state:

`AUTH_PRIVATE_JWK`, `AUTH_PUBLIC_JWKS`, `NIX_PRIVATE_JWK`, `NIX_PUBLIC_KEYS`,
and `BOOTSTRAP_SECRET_HASH`.

The processor image is public and immutable by digest. Private mirrors are an
explicit, per-deployment override; they are not added to the normal upgrade
workflow.

See [TESTING.md](TESTING.md) for the clean-account acceptance matrix,
including a real `nix copy`, rollback, preview, external-CI, and teardown
checks.
