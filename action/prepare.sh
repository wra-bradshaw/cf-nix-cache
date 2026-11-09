#!/usr/bin/env bash
# Runs before Nix is installed: writes the settings the installer needs and,
# when the action is used at a release tag, downloads that release's CLI.
set -euo pipefail

spool="$RUNNER_TEMP/cf-nix-cache"
mkdir -p "$spool/bin"

# Only a release tag (GITHUB_ACTION_PATH is .../_actions/OWNER/REPO/vX.Y.Z)
# has a matching binary; otherwise the CLI is built once Nix is installed.
download_cli() {
  local ref repo version system
  ref="$(basename "$GITHUB_ACTION_PATH")"
  repo="$(basename "$(dirname "$(dirname "$GITHUB_ACTION_PATH")")")/$(basename "$(dirname "$GITHUB_ACTION_PATH")")"
  version="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$GITHUB_ACTION_PATH/Cargo.toml" | head -n 1)"
  [ "$ref" = "v$version" ] || return 0
  case "$RUNNER_OS-$RUNNER_ARCH" in
    Linux-X64) system=x86_64-linux ;;
    Linux-ARM64) system=aarch64-linux ;;
    macOS-ARM64) system=aarch64-darwin ;;
    *) return 0 ;;
  esac
  if curl -fsSL --retry 3 -o "$spool/bin/cf-nix-cache" \
    "https://github.com/$repo/releases/download/$ref/cf-nix-cache-$system"; then
    chmod 755 "$spool/bin/cf-nix-cache"
  else
    echo "::warning::no $system binary in the $ref release; building the CLI instead"
    rm -f "$spool/bin/cf-nix-cache"
  fi
}

if [ -z "$ENDPOINT" ]; then
  echo "::warning::no cf-nix-cache endpoint; installing Nix without the cache"
  exit 0
fi
endpoint="${ENDPOINT%/}"
conf="extra-substituters = $endpoint/cache/$CACHE
extra-trusted-public-keys = $PUBLIC_KEY"

if [ -n "$PULL_TOKEN" ]; then
  host="${endpoint#*://}"
  (umask 077 && echo "machine ${host%%/*} login token password $PULL_TOKEN" > "$spool/netrc")
  sudo mkdir -p /etc/determinate
  jq -n --arg netrc "$spool/netrc" '{authentication: {additionalNetrcSources: [$netrc]}}' |
    sudo tee /etc/determinate/config.json > /dev/null
fi

if [ -n "$PUSH_TOKEN" ]; then
  # shellcheck disable=SC2016 # expanded by the hook
  printf '#!/bin/sh\necho "$OUT_PATHS" >> %s/queue\n' "$spool" > "$spool/hook"
  chmod 755 "$spool/hook"
  conf+="
post-build-hook = $spool/hook"
  echo "push=true" >> "$GITHUB_OUTPUT"
  download_cli
fi

{
  echo "conf<<CF_NIX_CACHE_EOF"
  echo "$conf"
  echo "CF_NIX_CACHE_EOF"
} >> "$GITHUB_OUTPUT"
