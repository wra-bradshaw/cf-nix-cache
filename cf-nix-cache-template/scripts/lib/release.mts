import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fail } from "./fail.mts";

export type ReleaseManifest = {
  schemaVersion: 2;
  releaseReady: boolean;
  version: string;
};

export async function releaseManifest(): Promise<ReleaseManifest> {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("cf-nix-cache/release-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    schemaVersion?: unknown;
    releaseReady?: unknown;
    version?: unknown;
  };
  if (manifest.schemaVersion !== 2)
    fail(
      `unsupported cf-nix-cache release manifest schema ${String(manifest.schemaVersion)}; this template needs schema 2. Upgrade this template and the cf-nix-cache package together.`,
    );
  if (manifest.releaseReady !== true)
    fail("the installed cf-nix-cache release is not marked release-ready");
  if (
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
  )
    fail(
      `invalid package version in release manifest: ${String(manifest.version)}`,
    );
  return {
    schemaVersion: 2,
    releaseReady: true,
    version: manifest.version,
  };
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
