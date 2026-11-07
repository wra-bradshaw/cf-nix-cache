---
'cf-nix-cache': patch
---

Fix cache deletion, which always failed with HTTP 500 on Cloudflare because its Workflow instance ID contained a colon. A cache left in `DELETING` finishes when the delete is retried. Log the error stack for unhandled errors, which previously appeared as `{}`.
