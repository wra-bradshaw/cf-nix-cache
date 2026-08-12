# `cf-nix-cache`

This package contains the compiled Worker runtime used by the public
`cf-nix-cache-template`. It is intentionally separate from the development
monorepo: customers upgrade this package, while their Wrangler configuration,
resource names, scaling, placement, routes, and observability settings remain
owned by their deployment repository.

Every published version includes `release-manifest.json`. The manifest pins
the matching processor to an immutable `linux/amd64` image digest so a package
upgrade cannot accidentally deploy a different container.

`releaseReady` is set to `false` by the Changesets version step and becomes
`true` only in the reviewed digest-pinning PR. Publication workflows must
reject manifests that have not been finalized.
