---
'cf-nix-cache': minor
---

Harden the deployment template and centralize durable storage access. Template configuration now uses tested loaders with schema enforcement, `doctor` diagnoses deployments, and deploy/preview/rotation helpers align with Worker verification. Durable Objects share a typed SQLite toolkit (`shared/sql.ts`) with row readers, JSON columns, keyset pagination, and transactional migrations, and the upload lifecycle is pinned as an explicit state machine with transition assertions.
