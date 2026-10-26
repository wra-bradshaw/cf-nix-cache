// Validates the exact config that `pnpm run deploy` hands to Wrangler: the
// customer wrangler.jsonc with the release manifest's processor image. It
// performs a local dry run only and needs no Cloudflare credentials.
import { releaseImage, withRenderedConfig, wrangler } from "./lib.mts";

const { image } = await releaseImage();
await withRenderedConfig(image, async (rendered) => {
  await wrangler(["deploy", "--dry-run"], {}, rendered);
});
console.log(`rendered config is deployable with processor ${image}`);
