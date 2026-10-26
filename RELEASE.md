# Release procedure

1. Run Rust formatting/tests/Clippy, Worker typecheck/tests, and `nix flake check`.
2. Build the CLI and Nix-built processor image. Run deployed smoke tests for health,
   bootstrap, token revocation, public/private Nix downloads, range resumes,
   duplicate uploads, forced Workflow retries, quota eviction, and GC.
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
version, the image is not an immutable digest, or the platform is not
`linux/amd64`.

### Automated release flow

The version PR and the digest-pinning PR are opened with `GITHUB_TOKEN`,
which does not trigger `pull_request` workflows. Both workflows therefore
dispatch `ci.yml` on their branch (`gh workflow run ci.yml --ref <branch>`,
requiring `actions: write`), so the PR head commit still receives CI checks.

Runtime changes should include a Changeset (`pnpm changeset`). The `Release
PR` workflow accumulates those files into a version PR and synchronizes the
new version into the release manifest and deployment template. Merging the
version PR does not publish an incomplete npm package.

After the version PR is merged, run the protected `Prepare release artifacts`
workflow with the public Docker Hub repository, such as
`docker.io/willlol/cf-nix-cache`. It builds the Nix processor image,
pushes a source-specific tag, resolves the registry digest, and opens a second
PR that pins the digest in both the npm release manifest and the template
Wrangler configuration. The workflow requires `DOCKERHUB_USERNAME` and a
repository-scoped `DOCKERHUB_TOKEN` in the `release` GitHub Environment.

Merging the digest PR triggers `Publish release`. That workflow verifies the
public image by digest, rebuilds and tests the Worker package, publishes npm
from the pinned commit, and creates `vX.Y.Z` on GitHub. Configure the npm
package's trusted publisher for `.github/workflows/publish-release.yml`; npm
publishing uses GitHub OIDC and does not require a long-lived npm token.
The version workflow sets `releaseReady` to false and only the digest-pinning
workflow sets it to true, preventing a version PR from publishing the previous
processor image accidentally.

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
