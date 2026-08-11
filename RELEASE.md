# Release procedure

1. Run Rust formatting/tests/Clippy, Worker typecheck/tests, Terraform
   formatting/validation, and `nix flake check`.
2. Build the CLI and Nix-built processor image. Run deployed smoke tests for health,
   bootstrap, token revocation, public/private Nix downloads, range resumes,
   duplicate uploads, forced Workflow retries, quota eviction, and GC.
3. Apply Terraform for R2/routing prerequisites, install Wrangler secrets, and
   run `nix run .#deploy -- apply`. This builds the cached `linux/amd64` Nix
   image, pushes its immutable tag to Cloudflare Registry, and deploys the
   Worker/Container.
4. Bootstrap the installation once, create a cache, issue a scoped CI token,
   and complete a stock-Nix restore before directing production DNS.

Cloudflare Worker and Durable Object lifecycle changes are deployed through
Wrangler. Terraform does not own the Worker script. Never place Ed25519
private keys, bootstrap secrets, or R2 credentials in Terraform state.
