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
# The version PR bumps the template's cf-nix-cache pin to the not-yet-published
# version, and the scratch copy has no lockfile, so `pnpm add` resolves the old
# registry spec first and fails with ERR_PNPM_NO_MATCHING_VERSION. Strip the
# registry spec so the file: tarball is the only source for the package.
node -e 'const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,"utf8"));delete (j.dependencies||{})["cf-nix-cache"];fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");' "$scratch/template/package.json"
pnpm --dir "$scratch/template" add "file:$scratch/$tarball"
pnpm --dir "$scratch/template" run check
