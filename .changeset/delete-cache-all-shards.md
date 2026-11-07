---
'cf-nix-cache': patch
---

Fix cache deletion leaving most of a cache's index behind. It cleared 225 of the 1024 index shards, so the rest kept their rows in Durable Object storage permanently. Those rows were never served. Deletion now clears every shard, and takes longer as a result. Rows left by earlier deletions are not recovered.
