---
'cf-nix-cache': minor
---

Add automatic garbage collection. A weekly run now deletes manifests and chunks that no cache references, including those left behind by deleted paths and caches. Caches keep paths indefinitely unless you opt in with `cf-nix-cache cache retention <cache> <days>`, which evicts paths not used for that many days. Use `cf-nix-cache gc run --dry-run` to preview a run and `cf-nix-cache gc status` to see the last result. Uploads wait briefly while a run deletes objects.

**Upgrading requires changes to `wrangler.jsonc`:** add the `GC_CONTROL` Durable Object binding, a `v2` migration with `new_sqlite_classes: ["GcControl"]`, the `garbage-collect` workflow, and `limits.subrequests`. See the template's `wrangler.jsonc`. Deploys fail with a clear error until the binding and workflow are present.
