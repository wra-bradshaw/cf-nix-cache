---
"cf-nix-cache": minor
---

Run the processor Container under the `durable_object` scheduling policy, which
accounts that cannot create `default`-policy Container applications require.
`ProcessorContainer` now starts its own container from the `processor` image in
`ctx.container.images` instead of using `@cloudflare/containers`, and the
`ContainerProxy` export is replaced by `ObjectStoreProxy`. Deployments must
switch `wrangler.jsonc` to `scheduling_policy: "durable_object"` with an
`images.processor` Dockerfile, and `max_instances` is no longer supported. The
scheduling policy cannot be changed in place, so an existing deployment gets a
new Container application.
