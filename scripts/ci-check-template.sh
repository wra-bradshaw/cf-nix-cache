#!/usr/bin/env bash
set -euo pipefail
tmpdir=$(mktemp -d)
backup_pkg=$(mktemp)
backup_lock=$(mktemp)
cp cf-nix-cache-template/package.json "$backup_pkg"
has_lock=0
if [ -f cf-nix-cache-template/pnpm-lock.yaml ]; then
  cp cf-nix-cache-template/pnpm-lock.yaml "$backup_lock"
  has_lock=1
fi
cleanup() {
  if [ -f "$backup_pkg" ]; then
    mv "$backup_pkg" cf-nix-cache-template/package.json
  fi
  if [ "$has_lock" = 1 ]; then
    if [ -f "$backup_lock" ]; then
      mv "$backup_lock" cf-nix-cache-template/pnpm-lock.yaml
    else
      rm -f cf-nix-cache-template/pnpm-lock.yaml
    fi
  else
    rm -f cf-nix-cache-template/pnpm-lock.yaml "$backup_lock"
  fi
  rm -rf "$tmpdir"
}
trap cleanup EXIT
nix develop --command npm pack ./packages/worker --pack-destination "$tmpdir"
shopt -s nullglob
tarballs=("$tmpdir"/cf-nix-cache-*.tgz)
if (( ${#tarballs[@]} == 0 )); then
  echo "ci-check-template: no cf-nix-cache tarball found in $tmpdir" >&2
  exit 1
fi
tarball="${tarballs[0]}"
nix develop --command pnpm --dir cf-nix-cache-template install --no-frozen-lockfile
nix develop --command pnpm --dir cf-nix-cache-template add "file:$tarball"
nix develop --command pnpm --dir cf-nix-cache-template run check:ci
nix develop --command pnpm --dir cf-nix-cache-template exec wrangler deploy --dry-run
