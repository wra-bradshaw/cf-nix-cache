---
'cf-nix-cache': minor
---

Remove the backwards-compatibility code. The staging upload routes, the `CREATED` state, Durable Object schema migrations, the processor-container upgrade path, and the CLI's handling of older servers are gone: nothing reads old data or talks to old clients and servers. **Existing installations must be recreated** from an empty deployment.
