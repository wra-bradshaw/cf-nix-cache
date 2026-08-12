# Template acceptance checklist

Run these checks from a clean Cloudflare account with a disposable GitHub
repository and a real `linux/amd64` processor digest. They are intentionally
outside the monorepo's Rust/Nix test suite because a Deploy button clones this
repository independently.

| Scenario               | Check                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First deployment       | Set only `CF_NIX_CACHE_BOOTSTRAP_SECRET`; run `pnpm setup`; verify Worker, seven Durable Object bindings, two Workflows, Container, R2 bucket, lifecycle rules, `/health`, and `/api/public-key`. |
| Bootstrap and Nix      | Run the generated command, create a public cache, and complete a real `nix copy` against `/cache/<name>`.                                                                                         |
| Idempotency            | Run `pnpm deploy` twice; the public key and all five Worker secret names remain unchanged.                                                                                                        |
| Package upgrade        | Update only `cf-nix-cache`; verify the rendered config changes only `ProcessorContainer.image`.                                                                                                   |
| Rollback               | Pin the previous package version and deploy; verify its manifest digest is restored.                                                                                                              |
| Missing/partial secret | Delete one Worker secret; `pnpm deploy` and `pnpm doctor` fail without generating a replacement key.                                                                                              |
| Container rollout      | Use a deliberately failing image in a disposable account; confirm the Worker version is uploaded but production Container rollout reports failure.                                                |
| Customer config        | Change bucket name, Worker name, `max_instances`, route, and observability; deploy and verify those values survive package upgrades.                                                              |
| Preview                | Run `pnpm preview`; verify a Worker version is uploaded and the production Container application is unchanged.                                                                                    |
| External CI            | Run the same `pnpm deploy` from GitHub Actions, GitLab CI, and a shell runner with Wrangler credentials.                                                                                          |
| Teardown safety        | Delete the Worker while the bucket is non-empty; verify the bucket and objects remain until explicitly removed.                                                                                   |

Private keys must not occur in repository files, command arguments, Wrangler
logs, or Terraform state. The helper's bulk secret input is stdin-only and all
temporary Wrangler configs are removed after deployment.
