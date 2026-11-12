#!/usr/bin/env bash
# Syncs cf-nix-cache-template/ into a checkout of the public template
# repository, regenerates its lockfile against the published cf-nix-cache
# release, and opens (or refreshes) an auto-merging PR.
#
#   GH_TOKEN=... update-template-repo.sh <source-checkout> <template-checkout> <owner/repo> <version>
set -euo pipefail
source_dir=$1 template_dir=$2 repository=$3 version=$4

rsync -a --delete --exclude .git "$source_dir/cf-nix-cache-template/" "$template_dir/"

package="cf-nix-cache@$version"
deadline=$((SECONDS + 300))
until pnpm view "$package" version >/dev/null 2>&1; do
  if ((SECONDS >= deadline)); then
    echo "$package never appeared on npm" >&2
    exit 1
  fi
  sleep 15
done

for attempt in $(seq 15); do
  if output=$(pnpm --dir "$template_dir" install --lockfile-only 2>&1); then
    printf '%s\n' "$output"
    break
  fi
  printf '%s\n' "$output" >&2
  if [ "$attempt" -eq 15 ] || ! grep -q 'ERR_PNPM_NO_MATCHING_VERSION' <<<"$output"; then
    exit 1
  fi
  sleep 20
done

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
