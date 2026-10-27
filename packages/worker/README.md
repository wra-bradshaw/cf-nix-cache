# `cf-nix-cache`

This package is the cf-nix-cache Worker. Its source lives here; the published
package contains only the compiled bundle used by the public
`cf-nix-cache-template`. Customers upgrade this package, while their Wrangler
configuration, resource names, scaling, placement, routes, and observability
settings remain owned by their deployment repository.

Every published version includes `release-manifest.json`. The manifest pins
the matching processor to an immutable `linux/amd64` image digest so a package
upgrade cannot accidentally deploy a different container.

`releaseReady` is set to `false` by the Changesets version step and becomes
`true` once the Release PR job has published the processor image and pinned
its digest. Publication workflows must
reject manifests that have not been finalized.
