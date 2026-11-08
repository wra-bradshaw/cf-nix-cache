// Validates the wrangler.jsonc that `pnpm run deploy` hands to Wrangler, and
// that the installed cf-nix-cache release matches this template. It reads
// local files only and needs no Cloudflare credentials.
import { readValidConfig } from "./lib/config.mts";
import { releaseManifest } from "./lib/release.mts";

const config = await readValidConfig();
const { version } = await releaseManifest();
console.log(`${config.name} config is valid for cf-nix-cache@${version}`);
