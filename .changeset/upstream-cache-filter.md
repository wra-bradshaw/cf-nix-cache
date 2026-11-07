---
'cf-nix-cache': minor
---

`cf-nix-cache push` now skips paths signed by a cache's upstream caches, so clients fetch them from there instead. Every cache, including existing ones, starts with `cache.nixos.org-1` as its upstream. **If your clients don't use cache.nixos.org, run `cf-nix-cache cache upstreams <cache> --none` after upgrading**, or their closures will have gaps. Set other upstreams with `cf-nix-cache cache upstreams <cache> <key-name>...` or `cache create --upstream-cache-key-name`, and upload everything for one push with `--ignore-upstream-cache-filter`.
