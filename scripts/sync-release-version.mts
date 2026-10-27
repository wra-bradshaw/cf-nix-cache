import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packagePath = path.join(
  repository,
  "packages/worker/package.json",
);
const manifestPath = path.join(
  repository,
  "packages/worker/release-manifest.json",
);
const templatePackagePath = path.join(
  repository,
  "cf-nix-cache-template/package.json",
);

const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
  name: string;
  version: string;
};
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
  version: string;
  releaseReady?: boolean;
  [key: string]: unknown;
};
manifest.version = packageJson.version;
manifest.releaseReady = false;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const templatePackage = JSON.parse(
  await readFile(templatePackagePath, "utf8"),
) as { dependencies?: Record<string, string> };
templatePackage.dependencies ??= {};
templatePackage.dependencies[packageJson.name] = packageJson.version;
await writeFile(
  templatePackagePath,
  `${JSON.stringify(templatePackage, null, 2)}\n`,
);

console.log(
  `synchronized release metadata for ${packageJson.name}@${packageJson.version}`,
);
