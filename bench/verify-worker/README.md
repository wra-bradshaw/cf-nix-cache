# Verification benchmark Worker

Measures the CPU cost of verifying client-encoded chunks in a deployed Worker,
using the Worker's own verifier (`crates/verify`, as WebAssembly). Results are
in [docs/COST_PLAN.md](../../docs/COST_PLAN.md).

It deploys as a throwaway Worker with its own bucket, `cf-nix-cache-bench`, and
the same `limits.cpu_ms` as the cache, so `VerifyWorkflow` runs verification
exactly as the upload workflow's step does.

```console
pnpm --dir ../../packages/worker generate   # builds src/generated/verify.wasm
pnpm --dir ../../packages/worker exec wrangler r2 bucket create cf-nix-cache-bench
pnpm --dir ../../packages/worker exec wrangler deploy --config "$PWD/wrangler.jsonc"
openssl rand -hex 24 > token
pnpm --dir ../../packages/worker exec wrangler secret put BENCH_TOKEN --config "$PWD/wrangler.jsonc" < token
pnpm --dir ../../packages/worker exec wrangler tail cf-nix-cache-bench-verify --format json > tail.json
```

Upload a NAR's chunks with `upload-nar.mts`, from a store path or generated:

```console
BENCH_TOKEN=$(cat token) node upload-nar.mts "$URL" rustc /nix/store/<hash>-rustc-<version>
BENCH_TOKEN=$(cat token) node upload-nar.mts "$URL" small synthetic:256     # small files, ~2.6:1
BENCH_TOKEN=$(cat token) node upload-nar.mts "$URL" big repetitive:4096     # small files, ~40:1
```

| Route | Does |
| --- | --- |
| `PUT /put?key=` | stores an object; needs `authorization: Bearer $BENCH_TOKEN` |
| `POST /workflow?manifest=bench/<name>.json` | verifies the NAR in one `VerifyWorkflow` step |
| `GET /workflow/<id>` | the instance's status |
| `/verify?manifest=` | the same verification in a request |
| `/b1?key=&raw=&iters=` | decoding one chunk and hashing it, `iters` times |
| `/list?prefix=`, `/manifest?key=` | inspect the bucket |

A Worker's clock does not advance while it computes, so read each run's
`cpuTime` from the tail. A Workflow's tail event arrives once its isolate
shuts down, a minute or two after the instance completes. Delete everything
afterwards with `wrangler delete cf-nix-cache-bench-verify`, and empty and
delete the bucket.
