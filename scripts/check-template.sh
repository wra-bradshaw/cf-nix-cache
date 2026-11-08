#!/usr/bin/env bash
# Runs the deployment template's checks against the working-tree Worker
# package, in a scratch copy so the tracked template is never modified.
# Expects `pnpm --dir packages/worker build` to have run.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f packages/worker/dist/index.js ] || {
  echo "check-template: build packages/worker first" >&2
  exit 1
}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
rsync -a --exclude node_modules --exclude .wrangler --exclude pnpm-lock.yaml \
  cf-nix-cache-template/ "$scratch/template/"
tarball=$(npm pack ./packages/worker --ignore-scripts --silent --pack-destination "$scratch")
pnpm --dir "$scratch/template" add "file:$scratch/$tarball"
pnpm --dir "$scratch/template" run check
