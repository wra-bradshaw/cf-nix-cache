---
'cf-nix-cache': minor
---

Re-arm bootstrap by setting a new `BOOTSTRAP_SECRET_HASH`, so a lost or expired admin token is recoverable. Each secret still works only once, and the secret configured when upgrading is treated as used. Raise the maximum token lifetime from 5 years to 200 years.
