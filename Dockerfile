# The processor image is built by Nix. Wrangler requires a Dockerfile for
# container images, so this wrapper adds no build or runtime layers. Local
# development uses the loaded Nix image; `nix run .#deploy -- apply` sets
# PROCESSOR_IMAGE to the tag it loaded.
ARG PROCESSOR_IMAGE=cf-nix-cache-processor:nix-local
FROM ${PROCESSOR_IMAGE}
EXPOSE 8080
