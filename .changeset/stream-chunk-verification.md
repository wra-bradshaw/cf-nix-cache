---
'cf-nix-cache': patch
---

Verify uploads without holding every chunk in memory. Verification kept each compressed chunk it read until the whole NAR was checked, so a NAR whose chunks barely compress (a large `.tar.gz`, for example) exceeded the Worker's 128 MB memory limit and the upload failed with Cloudflare error 1102. Each chunk is now released once it has been checked; a repeated chunk is read again.
