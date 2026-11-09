---
'cf-nix-cache': minor
---

Allow uploads whose chunk list repeats a chunk. NARs with repeated content chunk to the same bytes more than once, which the Worker rejected; the ordered list now keeps repeats for reconstruction while storage, quota, and verification account each distinct chunk once.
