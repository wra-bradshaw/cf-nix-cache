# cf-nix-cache

Cloudflare-native, stock-Nix-compatible binary cache.

The data plane is a TypeScript Cloudflare Worker. SQLite-backed Durable
Objects own mutable state and serialization, R2 stores immutable
content-addressed chunks, and the CLI chunks and compresses each NAR itself, so
a push sends only the chunks the installation lacks and the Worker checks them
before publishing. The checks run in the Worker itself, with a Rust verifier
compiled to WebAssembly: in the completing request for NARs up to 256 MiB, and
in a retryable Workflow step for larger ones.

## Layout

- `packages/worker`: the Worker (HTTP API, Nix substituter, authentication,
  Durable Objects, and Workflows). It is also the published `cf-nix-cache`
  npm package, together with its release manifest.
- `crates/core`: Rust protocol values, encoding parameters, and manifest
  validation.
- `crates/contracts`: generated Rust wire DTOs from the JSON Schemas.
- `crates/verify`: the upload verifier, compiled to wasm32 and bundled with
  the Worker: stored chunks decode (C zstd) to their declared sizes and make up
  a valid NAR. The Worker hashes them with native SHA-256.
- `crates/cli`: Nix publisher (including the client-side encoder) and
  administration client.
- `schemas`: JSON contracts shared by Worker and Rust.
- `cf-nix-cache-template`: the isolated public Deploy-to-Cloudflare template.

`wrangler.jsonc` is the source of truth for the Worker, its bindings, and
routes. The deploy app ensures the R2 bucket and its staging lifecycle
rule via the Wrangler CLI before deploying; custom hostnames are a
`routes` entry in `wrangler.jsonc`.

## Cloudflare distribution

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wra-bradshaw/cf-nix-cache-template)

The supported customer distribution is the standalone
[`cf-nix-cache-template`](cf-nix-cache-template/README.md). It contains only a
tiny Worker entrypoint, pinned Wrangler/dependency versions, customer-owned
`wrangler.jsonc`, and setup/upgrade helpers. Cloudflare Workers Builds runs
`pnpm run deploy`; external CI can run the same command. No deployment from that
template builds Rust: the published package already contains the compiled
WebAssembly verifier.

Releases publish `cf-nix-cache@X.Y.Z`, so Dependabot/Renovate updates one
dependency, and customer names, placement, routes, and observability in the
template's `wrangler.jsonc` stay intact. Large uploads are verified in a
Workflow step with `limits.cpu_ms` of 300000, which needs the Workers Paid
plan. The development flake below remains useful for local builds and
integration tests; it is not the customer upgrade path.

## Local checks

Run these in `nix develop`. `nix flake check` runs the Rust fmt, clippy and
test checks with crane; the dev shell's cargo is the same toolchain. Generating
the Worker's sources copies the verifier wasm from the flake's `verifier`
package.

```console
nix flake check
cargo fmt --check
cargo test --workspace
pnpm --dir packages/worker install
pnpm --dir packages/worker check  # regenerates contracts and the verifier, then lints
pnpm --dir packages/worker test
pnpm --dir packages/worker check:all  # what CI runs: one generate, then lint, test, build and e2e
```

The deployment app has explicit `plan`, `apply`, and `destroy` modes. Only
`apply` requires Cloudflare credentials, verifies required Wrangler secrets,
ensures the R2 bucket and lifecycle rules, and deploys the Worker; `plan` is a
dry-run deploy and `destroy` prints manual teardown steps instead of deleting
anything.

Run the full local integration test with Miniflare, local R2, and a real Nix
closure:

```console
pnpm --dir packages/worker e2e
```

The test provisions an isolated Worker, Durable Object, and Workflow environment,
pushes `nixpkgs#hello`, verifies the signed Nix metadata and ranged NAR
responses, then reconstructs the closure with `nix copy`.

Generate Worker binding types after changing `wrangler.jsonc`:

```console
cp .dev.vars.example .dev.vars # if absent, so the secret types are included
pnpm --dir packages/worker exec wrangler types --config "$PWD/wrangler.jsonc"
```

Start local development with:

```console
nix run .#dev
```

Local development uses the top-level configuration in `wrangler.jsonc` (with
the `cf-nix-cache-dev` bucket); the required secrets, including `NIX_PUBLIC_KEYS`, are read
from a gitignored `.dev.vars` (copy `.dev.vars.example`). Deployments use
`env.production`.

For production, the deploy app builds the Worker, ensures the production R2
bucket and lifecycle rules, and deploys `env.production` from `wrangler.jsonc`.
Both apps run in the dev shell, entering it if needed:

```console
nix run .#deploy -- apply
```

Secrets are installed with `wrangler secret put` and never committed to the
repository:

```console
pnpm --dir packages/worker exec wrangler secret put AUTH_PRIVATE_JWK --config "$PWD/wrangler.jsonc" --env production
pnpm --dir packages/worker exec wrangler secret put AUTH_PUBLIC_JWKS --config "$PWD/wrangler.jsonc" --env production
pnpm --dir packages/worker exec wrangler secret put NIX_PRIVATE_JWK --config "$PWD/wrangler.jsonc" --env production
pnpm --dir packages/worker exec wrangler secret put NIX_PUBLIC_KEYS --config "$PWD/wrangler.jsonc" --env production
pnpm --dir packages/worker exec wrangler secret put BOOTSTRAP_SECRET_HASH --config "$PWD/wrangler.jsonc" --env production
```

## Storage contract

R2 keys are installation-global for deduplication:

```text
staging/{upload-id}.chunks.json
chunks/{encoding-id}/{raw-sha256}.zst
manifests/{encoding-id}/{nar-sha256}.json
```

The initial encoding profile is
`fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1`. Each raw chunk is an
independent zstd level-3 frame. The Worker concatenates frames while serving
the Nix URL and never decompresses them. Only the CLI compresses; the server never
depends on how a frame was compressed, because each manifest is built from the
stored bytes.

Chunks are shared by every cache of an installation, so a push token holder can
tell from the chunks a push reports missing whether content exists in any cache,
not only in theirs. That is no concern when one owner runs the installation;
give push tokens to others only if that is acceptable.

## Upstream caches

`push` skips paths signed with the key of a cache's upstreams, because clients can
fetch those from the upstream instead. Every cache starts with
`cache.nixos.org-1`, and `cache create` takes `--upstream-cache-key-name`,
which can be repeated, to choose otherwise.

```console
cf-nix-cache cache upstreams my-cache cache.nixos.org-1 nix-community.cachix.org-1
cf-nix-cache cache upstreams my-cache --none  # for clients without cache.nixos.org
cf-nix-cache push --ignore-upstream-cache-filter my-cache .#hello  # upload everything once
```

List only upstreams that your clients use and that keep their paths. A signature
shows that a cache signed a path, not that it still has it, and nothing checks.
If an upstream evicts a skipped path, clients have to build it.

## Garbage collection

A scheduled workflow runs weekly, by default on Sundays at 03:00 UTC, and deletes
manifests and chunks that no cache references. This reclaims the storage of
deleted paths and caches. Live paths are never removed unless you opt in to
retention for a cache:

```console
cf-nix-cache cache retention my-cache 30  # evict paths unused for 30 days (0 to disable)
cf-nix-cache gc run --dry-run             # preview a run, changing nothing
cf-nix-cache gc run                       # run now
cf-nix-cache gc status                    # the active run and the last result
```

Use means a narinfo or NAR request, or a push that finds the path already
present. Retention judges each path on its own, so a path can outlive one of its
dependencies. If a run has objects to delete, new uploads wait while it finishes,
usually for minutes; a run with nothing to delete does not affect them. To change
the schedule, edit `schedules` on the `garbage-collect` workflow. See
[the design](docs/ARCHITECTURE.md#garbage-collection).

## Security model

The `/api` control plane uses Ed25519 capability JWTs. Tokens contain exact
cache grants and are accepted as Bearer tokens or Basic-auth passwords for
stock Nix. Token revocation is recorded in the TokenCatalog and checked before
private access. Bootstrap is an idempotent secret exchange: each secret works
once, and setting a new `BOOTSTRAP_SECRET_HASH` re-arms it. Anyone who can set
Worker secrets already controls the installation, so this adds no new authority.
