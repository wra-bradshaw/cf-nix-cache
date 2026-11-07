---
'cf-nix-cache': minor
---

`cf-nix-cache push` now uploads store paths concurrently, 16 at a time by default (set with `--jobs`). A failed path no longer stops the rest of the push: the remaining paths still upload, each failure is reported, and the command exits non-zero.
