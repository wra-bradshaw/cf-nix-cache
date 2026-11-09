---
'cf-nix-cache': minor
---

Add a GitHub Action that installs Determinate Nix with the cache as a substituter and pushes each path as soon as it is built, so a failed job still caches what it finished. It is backed by the new `cf-nix-cache watch` command, and releases now include standalone CLI binaries for x86_64-linux, aarch64-linux and aarch64-darwin, which the action downloads.
