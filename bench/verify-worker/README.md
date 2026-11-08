# Verification benchmark Worker

Benchmarks B1 and B2 from [docs/COST_PLAN.md](../../docs/COST_PLAN.md): the
CPU cost of checking client-encoded chunks inside a deployed Worker, using the
Worker's own verification code. Results from the last run are in that file.

It needs a bucket that already holds chunks and manifests, for example a
throwaway installation that some real store paths were pushed to. Point
`bucket_name` in `wrangler.jsonc` at it (it only reads), then:

```console
pnpm --dir ../../packages/worker exec wrangler deploy --config "$PWD/wrangler.jsonc"
pnpm --dir ../../packages/worker exec wrangler tail cf-nix-cache-bench-verify --format json > tail.json
```

| Route | Measures |
| --- | --- |
| `/list?prefix=manifests/` | lists objects, to choose what to measure |
| `/manifest?key=` | returns a manifest, for chunk keys and raw sizes |
| `/b1?key=&raw=&iters=` | decoding one chunk and hashing it, `iters` times |
| `/b2?manifest=&validate=0\|1` | NAR structural validation: the difference between the two |
| `/verify?manifest=` | levels 2 and 3 together, as completion runs them |

A Worker's clock does not advance while it computes, so read each request's
`cpuTime` from the tail rather than timing inside the Worker. Fire several
`/b1` requests at once to check memory. Delete the Worker afterwards with
`wrangler delete cf-nix-cache-bench-verify`.
