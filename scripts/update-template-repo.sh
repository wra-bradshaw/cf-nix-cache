#!/usr/bin/env bash
# Syncs cf-nix-cache-template/ into a checkout of the public template
# repository, regenerates its lockfile against the published cf-nix-cache
# release, and opens (or refreshes) an auto-merging PR.
#
#   GH_TOKEN=... update-template-repo.sh <source-checkout> <template-checkout> <owner/repo> <version>
set -euo pipefail
source_dir=$1 template_dir=$2 repository=$3 version=$4

rsync -a --delete --exclude .git "$source_dir/cf-nix-cache-template/" "$template_dir/"

for attempt in $(seq 30); do
  npm view "cf-nix-cache@$version" version >/dev/null 2>&1 && break
  [ "$attempt" = 30 ] && { echo "cf-nix-cache@$version never appeared on npm" >&2; exit 1; }
  sleep 20
done
pnpm --dir "$template_dir" install --lockfile-only

cd "$template_dir"
if [ -z "$(git status --porcelain)" ]; then
  echo "Template repository is already current."
  exit 0
fi
branch="release/v$version"
title="Update cf-nix-cache to v$version"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git switch -C "$branch"
git add --all
git commit -m "$title"
git push --force origin "$branch"
if [ -z "$(gh pr list --repo "$repository" --head "$branch" --state open --json number --jq '.[0].number // empty')" ]; then
  gh pr create --repo "$repository" --base main --head "$branch" --title "$title" \
    --body "Updates the deployment template and lockfile for cf-nix-cache v$version."
fi
gh pr merge "$branch" --repo "$repository" --auto --squash
