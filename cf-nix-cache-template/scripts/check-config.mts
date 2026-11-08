import { readValidConfig } from "./lib/config.mts";
import { releaseManifest } from "./lib/release.mts";

const config = await readValidConfig();
const { version } = await releaseManifest();
console.log(`${config.name} config is valid for cf-nix-cache@${version}`);
