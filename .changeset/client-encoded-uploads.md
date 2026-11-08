---
'cf-nix-cache': minor
---

Make pushes cheaper and faster. The CLI now chunks and compresses each NAR itself and uploads only the chunks the installation lacks, and the Worker verifies them and publishes the path without a staging copy or, for NARs up to 256 MiB, a processor container. Concurrent pushes of the same path share one upload, and `missing` reports paths another push is uploading as `pending`. Processor containers are now `lite` instances drawn from a pool of 16 that stop after 10 idle seconds, and `missing` looks paths up in parallel. The whole-NAR staging upload is removed: CLIs from before client encoding are told to upgrade, and an unfinished staging upload is marked FAILED. No `wrangler.jsonc` changes are needed.
