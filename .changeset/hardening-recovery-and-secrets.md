---
'cf-nix-cache': minor
---

Fix upload and deletion recovery, and stop storing bearer tokens. A publish retry no longer conflicts with its own earlier attempt, a stopped workflow is now restarted, and lock contention or a dropped connection to R2 no longer fails an upload permanently. An interrupted cache creation no longer breaks `GET /api/caches`, and that cache can now be deleted. Replaying a token request now signs the token again from stored metadata and refuses revoked tokens, and tokens stored by earlier releases are cleared. API errors from a publication now carry their original code and status instead of `retryable_failure`. CLI: `cache configure` now requires `--public` or `--public=false` rather than silently making a cache private, `bootstrap --help` no longer prints the secret, and `--output json` prints the server's response unchanged. The Rust binaries and new manifests now report the release version, and the crates are correctly licensed MIT.
