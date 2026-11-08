import { readValidConfig } from "./lib/config.mts";
import { releaseManifest } from "./lib/release.mts";
import { wrangler } from "./lib/wrangler.mts";

export async function preview(): Promise<void> {
  await readValidConfig();
  await releaseManifest();
  await wrangler(["versions", "upload"]);
  console.log(
    "Uploaded a Worker version for preview; production traffic was not changed.",
  );
}
