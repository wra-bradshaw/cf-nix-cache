// Finalizes the release manifest and the template's pinned dependency for the
// version Changesets just wrote to packages/worker/package.json. Runs inside
// the Release PR job after `changeset version`, so the version PR is complete
// and merging it publishes the release.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageDirectory = path.join(repository, "packages/worker");

const packagePath = path.join(packageDirectory, "package.json");
const manifestPath = path.join(packageDirectory, "release-manifest.json");
const templatePackagePath = path.join(
  repository,
  "cf-nix-cache-template/package.json",
);
const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
  name: string;
  version: string;
};
const version = packageJson.version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
  throw new Error(`invalid semver version: ${version}`);

// An explicit --version guards against preparing a different release than
// the one Changesets versioned.
const versionIndex = process.argv.indexOf("--version");
if (versionIndex >= 0) {
  const expected = process.argv[versionIndex + 1];
  if (!expected) throw new Error("missing --version value");
  if (expected !== version)
    throw new Error(
      `package.json is versioned as ${version}; expected ${expected}. Run Changesets before preparing the release.`,
    );
}

await writeFile(
  manifestPath,
  `${JSON.stringify({ schemaVersion: 2, releaseReady: true, version }, null, 2)}\n`,
);
const templatePackage = JSON.parse(
  await readFile(templatePackagePath, "utf8"),
) as {
  dependencies?: Record<string, string>;
};
templatePackage.dependencies ??= {};
templatePackage.dependencies[packageJson.name] = version;
await writeFile(
  templatePackagePath,
  `${JSON.stringify(templatePackage, null, 2)}\n`,
);

console.log(`prepared ${packageJson.name}@${version}`);
