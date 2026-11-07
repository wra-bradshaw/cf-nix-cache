import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fail } from "./fail.mts";

type ReleaseManifest = {
  schemaVersion: number;
  version: string;
  processorImage: string;
  platform: string;
};

async function readReleaseManifest(): Promise<ReleaseManifest> {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("cf-nix-cache/release-manifest.json");
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as ReleaseManifest;
  if (manifest.schemaVersion !== 1)
    fail(`unsupported release manifest schema ${manifest.schemaVersion}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version))
    fail(`invalid package version in release manifest: ${manifest.version}`);
  return manifest;
}

export async function installedPackageVersion(): Promise<string> {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("cf-nix-cache");
  const packagePath = path.resolve(path.dirname(entry), "..", "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
    version?: string;
  };
  return packageJson.version ?? fail("installed Worker package has no version");
}

export function validateImageReference(image: string): void {
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    fail(
      `processor image must be immutable (expected a digest ending in @sha256:<64 hex characters>): ${image}`,
    );
  }
}

export async function releaseImage(): Promise<{
  manifest: ReleaseManifest;
  image: string;
}> {
  const manifest = await readReleaseManifest();
  validateImageReference(manifest.processorImage);
  if (manifest.platform !== "linux/amd64")
    fail(
      `processor release platform must be linux/amd64, got ${manifest.platform}`,
    );
  const image =
    process.env.CF_NIX_CACHE_PROCESSOR_IMAGE ?? manifest.processorImage;
  validateImageReference(image);
  return { manifest, image };
}
