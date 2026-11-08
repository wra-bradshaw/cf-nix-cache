# `cf-nix-cache`

This package is the cf-nix-cache Worker. Its source lives here; the published
package contains only the compiled bundle used by the public
`cf-nix-cache-template`. Customers upgrade this package, while their Wrangler
configuration, resource names, scaling, placement, routes, and observability
settings remain owned by their deployment repository.

Every published version includes `release-manifest.json`:

```json
{ "schemaVersion": 2, "releaseReady": true, "version": "X.Y.Z" }
```

`releaseReady` is set to `false` by the Changesets version step and becomes
`true` once the Release PR job has finalized the release. Publication
workflows must reject manifests that have not been finalized.

Uploads are verified in the Worker by `crates/verify`, compiled to
WebAssembly and shipped as `dist/assets/verify-<hash>.wasm` next to the
bundle. NARs over 256 MiB are verified in a Workflow step, so deployments must
set `limits.cpu_ms` to 300000, which needs the Workers Paid plan. Building the
package needs the repository's Nix dev shell (`nix develop`): the wasm is built
by the flake's `verifier` package.
