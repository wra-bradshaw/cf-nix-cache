# Template acceptance checklist

Run these checks from a clean Cloudflare account with a disposable GitHub
repository. They are intentionally outside the monorepo's Rust/Nix test suite
because a Deploy button clones this repository independently.

## First deployment

Set only `CF_NIX_CACHE_BOOTSTRAP_SECRET`; run `pnpm run setup`; verify
the Worker, seven Durable Object bindings, three Workflows, R2 bucket,
lifecycle rules, `/health`, and `/api/public-key`.

## Bootstrap and Nix

Run the generated command, create a public cache, and complete a real
`nix copy` against `/cache/<name>`.

## Large upload

Push a 1 GiB NAR as a sampled budget check (the 10 GiB worst case is not
exercised; ~6.6 s at 1 GiB extrapolating to ~66 s at 10 GiB from the measured
worst case of about 6.4 ms of CPU per MiB is a rough linear extrapolation,
not a measured bound). Verify the upload workflow step
finishes well under `limits.cpu_ms` 300000 (check `cpuTime` via
`wrangler tail`) and the path is published.

## Idempotency

Run `pnpm run deploy` twice; the public key and all five Worker secret
names remain unchanged.

## Missing/partial secret

Delete one Worker secret; `pnpm run deploy` and `pnpm run doctor` fail
without generating a replacement key.

## Customer config

Change bucket name, Worker name, route, and observability; deploy and
verify those values survive package upgrades.

## Preview

Run `pnpm run preview`; verify a Worker version is uploaded and
production traffic is unchanged.

## External CI

Run the same `pnpm run deploy` from GitHub Actions, GitLab CI, and a
shell runner with Wrangler credentials.

## Teardown safety

Delete the Worker while the bucket is non-empty; verify the bucket and
objects remain until explicitly removed.

Private keys must not occur in repository files, command arguments, or Wrangler
logs. The helper's bulk secret input is stdin-only and it writes no temporary
Wrangler configs.
