import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageDirectory = path.join(repository, "packages/worker");

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const version = option("--version");
const image = option("--image");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
  throw new Error(`invalid semver version: ${version}`);
if (!/^docker\.io\/.+@sha256:[0-9a-f]{64}$/.test(image))
  throw new Error("image must be a docker.io immutable digest reference");
if (/@sha256:0{64}$/.test(image))
  throw new Error("image must not use the zero-digest placeholder");

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
if (packageJson.version !== version) {
  throw new Error(
    `package.json is already versioned as ${packageJson.version}; expected ${version}. Run Changesets before preparing artifacts.`,
  );
}
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      releaseReady: true,
      version,
      processorImage: image,
      platform: "linux/amd64",
    },
    null,
    2,
  )}\n`,
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
const wranglerPath = path.join(
  repository,
  "cf-nix-cache-template/wrangler.jsonc",
);
const wrangler = await readFile(wranglerPath, "utf8");
const imageProperty =
  /("PROCESSOR_IMAGE"\s*:\s*")docker\.io\/[^"\s]+@sha256:[0-9a-f]{64}(")/;
if (!imageProperty.test(wrangler)) {
  throw new Error(
    "could not find the processor image in template wrangler.jsonc",
  );
}
await writeFile(wranglerPath, wrangler.replace(imageProperty, `$1${image}$2`));

console.log(`prepared ${packageJson.name}@${version}`);
console.log(`processor: ${image}`);
