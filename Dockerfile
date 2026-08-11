# The processor image is built by Nix. Wrangler/Vite require a Dockerfile for
# local container development, so this wrapper adds no build or runtime layers.
FROM cf-nix-cache-processor:nix-local
EXPOSE 8080
