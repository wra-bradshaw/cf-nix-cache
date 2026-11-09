---
'cf-nix-cache': patch
---

Recover uploads whose inline verification never finished. If the request verifying an upload died (a Worker resource limit, a deploy), the upload stayed `COMPLETING` forever: it could not be aborted, and every client pushing the same path waited on it for up to an hour. The upload's Durable Object now sets an alarm when inline verification starts, and if the upload is still `COMPLETING` ten minutes later it hands verification to the `process-upload` Workflow. Uploads already stuck are scheduled the same way the next time a client checks their state.
