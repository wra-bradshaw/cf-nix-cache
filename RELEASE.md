# Release procedure

1. Run Rust formatting/tests/Clippy, Worker typecheck/tests, and `nix flake check`.
2. Build the CLI and Nix-built processor image. Run deployed smoke tests for health,
   bootstrap, token revocation, public/private Nix downloads, range resumes,
   duplicate uploads, quota enforcement, and forced Workflow retries.
3. Install Wrangler secrets and run `nix run .#deploy -- apply`. This builds the
   cached `linux/amd64` Nix image, ensures the production R2 bucket and lifecycle
   rules, pushes its immutable tag to Cloudflare Registry, and deploys the
   Worker/Container.
4. Bootstrap the installation once, create a cache, issue a scoped CI token,
   and complete a stock-Nix restore before directing production DNS.

The Worker, Durable Objects, Workflows, Container, R2 binding, and routes are
all deployed through Wrangler from `wrangler.jsonc`. Never place Ed25519
private keys, bootstrap secrets, or R2 credentials in the repository.

## Public template release

The customer-facing release is intentionally independent of the development
monorepo layout:

1. Build and test `apps/worker`, then build `packages/cf-nix-cache-worker` from
   the generated Worker bundle.
2. Build the `linux/amd64` processor with Nix and publish it to
   `docker.io/willlol/cf-nix-cache` by digest. Do not publish or
   deploy a mutable tag.
3. Run `node scripts/release-worker-package.mts --version X.Y.Z --image docker.io/willlol/cf-nix-cache@sha256:<digest>` and publish the
   package with `pnpm --dir packages/cf-nix-cache-worker publish --access public`.
4. Update the template's pinned dependency and run its config validation. A
   dependency PR is the only normal customer upgrade input.

The package build fails if its release manifest does not match the package
version or the image is not an immutable `docker.io` digest. `pnpm
release:check` additionally rejects a platform other than `linux/amd64`.

### Automated release flow

Runtime changes should include a Changeset (`pnpm changeset`). On every push
to `main` with pending changesets, the `Release PR` workflow runs
`pnpm release:version`:

1. `changeset version` bumps the package and syncs the version into the
   release manifest and template (`releaseReady: false`).
2. `scripts/pin-processor-image.sh` builds the Nix processor image, pushes a
   source-specific tag to `PROCESSOR_REPOSITORY` (repository variable, default
   `docker.io/willlol/cf-nix-cache`), resolves the registry digest, and pins it
   in the release manifest (`releaseReady: true`) and template Wrangler config.

The result is a single version PR containing the whole release. The job needs
`DOCKERHUB_USERNAME` and a repository-scoped `DOCKERHUB_TOKEN` in the
`release` GitHub Environment. The PR is opened with `GITHUB_TOKEN`, which does
not trigger `pull_request` workflows, so the job dispatches `ci.yml` on the PR
branch (requiring `actions: write`).

Merging the version PR triggers `Publish release`. That workflow verifies the
public image by digest, rebuilds and tests the Worker package, publishes npm
from the pinned commit, and creates `vX.Y.Z` on GitHub. Configure the npm
package's trusted publisher for `.github/workflows/publish-release.yml`; npm
publishing uses GitHub OIDC and does not require a long-lived npm token.
`releaseReady` is only set to true once a digest has been pinned for the new
version, so a partially prepared version PR cannot publish the previous
processor image.

If the `TEMPLATE_REPOSITORY` variable is set to
`wra-bradshaw/cf-nix-cache-template`, the publish workflow also opens a PR in
the standalone template repository and generates its `pnpm-lock.yaml` against
the newly published package. Store `TEMPLATE_REPO_TOKEN` in the `release`
environment as a fine-grained token scoped to the template repository with
**Contents: read and write**, **Pull requests: read and write**, and
**Workflows: read and write** (the sync also updates the template's
`.github/workflows`). The job force-pushes `release/vX.Y.Z`, reuses an open PR
for that branch, or creates one, and fails if the PR cannot be created. The first
npm release may need to be bootstrapped with a short-lived npm token before its
trusted-publisher settings are available.

The two registries are deliberately ordered rather than treated as an atomic
transaction: Docker is published first, then npm references its immutable
digest. A failed npm publication can be retried without changing the image.
