#!/usr/bin/env bash
# Builds the linux/amd64 processor image with Nix, publishes it to Docker Hub,
# and pins its immutable digest into the release manifest and the template.
# Runs inside the Release PR job after `changeset version`, so the version PR
# is complete and merging it publishes the release.
set -euo pipefail

: "${PROCESSOR_REPOSITORY:?set PROCESSOR_REPOSITORY, e.g. docker.io/<namespace>/<repository>}"
case "$PROCESSOR_REPOSITORY" in
  docker.io/*/*) ;;
  *) echo "PROCESSOR_REPOSITORY must be docker.io/<namespace>/<repository>" >&2; exit 1 ;;
esac

version="$(node -p "require('./packages/worker/package.json').version")"
revision="$(git rev-parse --short=12 HEAD)"
tag="$PROCESSOR_REPOSITORY:v$version-$revision"

if docker buildx imagetools inspect "$tag" >/dev/null 2>&1; then
  echo "Reusing processor image $tag."
else
  image_path="$(nix build .#packages.x86_64-linux.processorImage --no-link --print-out-paths)"
  docker load --input "$image_path"
  docker tag cf-nix-cache-processor:nix "$tag"
  docker push "$tag"
fi

digest="$(docker buildx imagetools inspect "$tag" --format '{{json .Manifest}}' | jq -er '.digest')"
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "invalid registry digest: $digest" >&2
  exit 1
fi

pnpm release:prepare --version "$version" --image "$PROCESSOR_REPOSITORY@$digest"
pnpm release:check
