# cf-nix-cache

Cloudflare-native, stock-Nix-compatible binary cache.

The data plane is a TypeScript Cloudflare Worker. SQLite-backed Durable
Objects own mutable state and serialization, R2 stores staged uploads and
immutable content-addressed chunks, Workflows drive retryable processing, and
a native Rust Container validates NARs and produces deterministic zstd frames.

## Layout

- `apps/worker`: HTTP API, Nix substituter, authentication, Durable Objects,
  Container binding, and Workflows.
- `crates/core`: Rust protocol values, NAR-info signing helpers, and manifest
  validation.
- `crates/contracts`: generated Rust wire DTOs from the JSON Schemas.
- `crates/processor`: native Container service for zstd/NAR validation,
  FastCDC v2020 chunking, deterministic compression, and R2 writes.
- `crates/cli`: Nix publisher and administration client.
- `schemas`: JSON contracts shared by Worker and Rust.
- `infra`: Terraform-managed R2, lifecycle, DNS, and Worker route resources.
- `packages/cf-nix-cache-worker`: the published Worker runtime and its
  immutable processor release manifest.
- `cf-nix-cache-template`: the isolated public Deploy-to-Cloudflare template.

Terraform owns account resources. Wrangler owns the Worker bundle, Durable
Object namespaces, Workflows, and Container image deployment; the same Worker
must not be managed by both tools.

## Cloudflare distribution

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wra-bradshaw/cf-nix-cache-template)

The supported customer distribution is the standalone
[`cf-nix-cache-template`](cf-nix-cache-template/README.md). It contains only a
tiny Worker entrypoint, pinned Wrangler/dependency versions, customer-owned
`wrangler.jsonc`, and setup/upgrade helpers. Cloudflare Workers Builds runs
`pnpm deploy`; external CI can run the same command. No deployment from that
template builds Rust or a Container image.

Releases publish `cf-nix-cache@X.Y.Z` and the matching public
`linux/amd64` processor image. The package's release manifest records the
immutable image digest, so Dependabot/Renovate updates one dependency. The
template renders a temporary Wrangler config that changes only the processor
image and leaves customer names, scaling, placement, routes, and observability
intact. The development flake below remains useful for local builds and
integration tests; it is not the customer upgrade path.

## Local checks

```console
cargo fmt --check
cargo test --workspace
pnpm --dir apps/worker install
pnpm --dir apps/worker check
pnpm --dir apps/worker test
pnpm --dir apps/worker contracts:check
pnpm --dir apps/worker boundaries:check
terraform -chdir=infra init -backend=false -input=false
terraform -chdir=infra validate
```

The deployment app has explicit `plan`, `apply`, and `destroy` modes. Only
`apply` requires Cloudflare credentials, verifies required Wrangler secrets,
and deploys the Worker; `plan` and `destroy` do not deploy code.

Run the full local integration test with Miniflare, local R2, the native Rust
processor, and a real Nix closure:

```console
pnpm --dir apps/worker e2e
```

The test provisions an isolated Worker, Durable Object, and Workflow environment,
pushes `nixpkgs#hello`, verifies the signed Nix metadata and ranged NAR
responses, then reconstructs the closure with `nix copy`.

The Container reaches R2 at the virtual `http://cache.r2` origin. Wrangler's
Container egress interception dispatches that host to the Worker's R2 binding,
so local development requires neither an S3 endpoint nor R2 access keys.

Generate Worker binding types after changing `wrangler.jsonc`:

```console
pnpm --dir apps/worker exec wrangler types --config "$PWD/wrangler.jsonc"
```

The processor image is built by Nix for `x86_64-linux`, using the Crane/Fenix
toolchain and the configured Linux builder. Docker is only used to load the
result locally and to perform Wrangler's registry operation; it never builds
Rust. Start local development with:

```console
nix run .#dev
```

For production, the deploy app builds the same cached Nix image, pushes an
immutable tag to Cloudflare Registry, and deploys a generated Wrangler config
that references that tag:

```console
nix run .#deploy -- apply
```

The first local run requires a Docker-compatible engine. Subsequent runs reuse
the loaded image when the Nix output is unchanged. Secrets are installed with
`wrangler secret put` and never belong in Terraform state:

```console
pnpm --dir apps/worker exec wrangler secret put AUTH_PRIVATE_JWK --config "$PWD/wrangler.jsonc"
pnpm --dir apps/worker exec wrangler secret put AUTH_PUBLIC_JWKS --config "$PWD/wrangler.jsonc"
pnpm --dir apps/worker exec wrangler secret put NIX_PRIVATE_JWK --config "$PWD/wrangler.jsonc"
pnpm --dir apps/worker exec wrangler secret put NIX_PUBLIC_KEYS --config "$PWD/wrangler.jsonc"
pnpm --dir apps/worker exec wrangler secret put BOOTSTRAP_SECRET_HASH --config "$PWD/wrangler.jsonc"
```

## Storage contract

R2 keys are installation-global for deduplication:

```text
staging/{upload-id}.nar.zst
chunks/{encoding-id}/{raw-sha256}.zst
manifests/{encoding-id}/{nar-sha256}.json
```

The initial encoding profile is
`fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1`. Each raw chunk is an
independent zstd level-3 frame. The Worker concatenates frames while serving
the Nix URL and never decompresses them.

## Security model

The `/api` control plane uses Ed25519 capability JWTs. Tokens contain exact
cache grants and are accepted as Bearer tokens or Basic-auth passwords for
stock Nix. Token revocation is recorded in the TokenCatalog and checked before
private access. Bootstrap is a one-time, idempotent secret exchange.

This project targets a greenfield deployment. Existing AWS resources remain
outside its ownership and must be handled separately.
