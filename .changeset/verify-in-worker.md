---
'cf-nix-cache': minor
---

Verify large uploads in the Worker. NARs over 256 MiB are now checked in a `ProcessUploadWorkflow` step by a WebAssembly verifier (the C zstd library plus NAR structural validation, with native SHA-256) instead of a processor container: about 66 s of CPU at worst for a 10 GiB NAR, and no container time or egress. The processor container, its Docker image, and the `ProcessorContainer` and `ObjectStoreProxy` exports are gone. Deployments must update `wrangler.jsonc`: remove the `containers` section and the `PROCESSOR` Durable Object binding, add a migration with `"deleted_classes": ["ProcessorContainer"]` (the template uses tag `v3`), and set `"limits": { "cpu_ms": 300000 }`. A `cpu_ms` above 30 s needs the Workers Paid plan. `release-manifest.json` is now `schemaVersion` 2 and contains only `schemaVersion`, `releaseReady`, and `version`.
