import { withRenderedConfig } from "./lib/config.mts";
import { releaseImage } from "./lib/release.mts";
import { wrangler } from "./lib/wrangler.mts";

export async function preview(): Promise<void> {
  const { image } = await releaseImage();
  await withRenderedConfig(image, async (rendered) => {
    await wrangler(["versions", "upload"], {}, rendered);
  });
  console.log(
    "Uploaded a Worker version for preview; production Container state was not changed.",
  );
}
