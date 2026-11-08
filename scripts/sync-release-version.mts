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

const rustCrates = /(name = "cf-nix-cache(?:-core|-contracts|-verify)?"\nversion = )"[^"]+"/g;
const edits: [string, (source: string) => string][] = [
  [
    "Cargo.toml",
    (source) =>
      source.replace(/^version = "[^"]+"/m, `version = "${packageJson.version}"`),
  ],
  [
    "Cargo.lock",
    (source) => source.replace(rustCrates, `$1"${packageJson.version}"`),
  ],
  [
    "nix/packages.nix",
    (source) =>
      source.replace(/version = "[^"]+";/g, `version = "${packageJson.version}";`),
  ],
];
for (const [file, edit] of edits) {
  const target = path.join(repository, file);
  await writeFile(target, edit(await readFile(target, "utf8")));
}

console.log(
  `synchronized release metadata for ${packageJson.name}@${packageJson.version}`,
);
