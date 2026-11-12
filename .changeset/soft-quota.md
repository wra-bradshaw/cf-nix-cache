---
'cf-nix-cache': minor
---

Replace the publication protocol with a soft quota. A publication interrupted between reserving a change and committing it locked its path forever, and every later publish of that path failed with `mutation_in_progress`. A path change is now one transaction on the shard that owns the path, so there is nothing to leave behind. Quota is a soft limit, checked when an upload is opened against the total the coordinator was last told, so uploads opened at once can overshoot it by their own size and eviction brings the cache back under the watermark. Each shard reports its total bytes and revision after every change, and the daily eviction run refreshes every shard's total before deciding anything, so a lost report is repaired within a day. Logical bytes count each path's chunks, not distinct R2 objects. **Existing installations must be recreated:** existing caches are not migrated.
