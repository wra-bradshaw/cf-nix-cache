# Release procedure

1. Run Rust formatting/tests/Clippy, Worker typecheck/tests, and `nix flake check`.
2. Build the CLI and the Worker. Run deployed smoke tests for health,
   bootstrap, token revocation, public/private Nix downloads, range resumes,
   duplicate uploads, quota enforcement, and forced Workflow retries.
3. Install Wrangler secrets and run `nix run .#deploy -- apply`. This builds the
   Worker (including the WebAssembly verifier), ensures the production R2 bucket
   and lifecycle rules, and deploys the Worker.
4. Bootstrap the installation once, create a cache, issue a scoped CI token,
   and complete a stock-Nix restore before directing production DNS.

The Worker, Durable Objects, Workflows, R2 binding, and routes are
all deployed through Wrangler from `wrangler.jsonc`. Never place Ed25519
private keys, bootstrap secrets, or R2 credentials in the repository.

## Public template release

The customer-facing release is intentionally independent of the development
monorepo layout:

1. Build and test `packages/worker` in `nix develop`. `pnpm build` compiles
   the verifier to WebAssembly, runs `vite build`, and then lays out the npm
   package (`dist/index.js`, `dist/index.d.ts`, `dist/assets/verify-<hash>.wasm`).
2. Run `pnpm release:prepare --version X.Y.Z`, which finalizes the release
   manifest and the template's pinned dependency, and publish the package with
   `pnpm --dir packages/worker publish --access public`.
3. Run the template's config validation. A dependency PR is the only normal
   customer upgrade input.

The release manifest is `{ "schemaVersion": 2, "releaseReady": true,
"version": "X.Y.Z" }`. The package build fails if it does not match the
package version, and `pnpm release:check` also rejects any other field.

### Automated release flow

Runtime changes should include a Changeset (`pnpm changeset`). On every push
to `main` with pending changesets, the `Release PR` workflow runs
`pnpm release:version`:

1. `changeset version` bumps the package and syncs the version into the
   release manifest, the template, and the Rust workspace and Nix packages
   (`releaseReady: false`).
2. `pnpm release:prepare` finalizes the release manifest
   (`releaseReady: true`) and the template's dependency, and `pnpm
   release:check` validates the result.

The result is a single version PR containing the whole release, set to
auto-merge once CI passes. A changeset reaching `main` therefore releases without
further review. The job needs `RELEASE_TOKEN` in the `release` GitHub
Environment.

`RELEASE_TOKEN` is a fine-grained token scoped to this repository with
**Contents: read and write** and **Pull requests: read and write**. It replaces
`GITHUB_TOKEN` because pushes and merges made with `GITHUB_TOKEN` do not trigger
workflows, which would leave the version PR without CI and stop its merge from
publishing. If it expires, the `Release PR` job fails until the secret is
replaced.

Merging the version PR triggers `Publish release`. To retry a failed publication,
run `gh workflow run publish-release.yml --ref main`. That workflow rebuilds
and tests the Worker package in the Nix dev shell, publishes npm from the
pinned commit, and creates `vX.Y.Z` on GitHub. Configure the npm
package's trusted publisher for `.github/workflows/publish-release.yml`; npm
publishing uses GitHub OIDC and does not require a long-lived npm token.
`releaseReady` is only set to true by `release:prepare`, so a version PR whose
preparation failed part-way cannot publish.

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
