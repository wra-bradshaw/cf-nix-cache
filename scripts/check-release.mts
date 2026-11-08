import { appendFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const allowPlaceholder = process.argv.includes("--allow-placeholder");
const writeGithubOutput = process.argv.includes("--github-output");

const packageJson = JSON.parse(
  await readFile(
    path.join(repository, "packages/worker/package.json"),
    "utf8",
  ),
) as { name: string; version: string };
const manifest = JSON.parse(
  await readFile(
    path.join(repository, "packages/worker/release-manifest.json"),
    "utf8",
  ),
) as {
  schemaVersion: number;
  releaseReady?: boolean;
  version: string;
};
const templatePackage = JSON.parse(
  await readFile(
    path.join(repository, "cf-nix-cache-template/package.json"),
    "utf8",
  ),
) as { dependencies?: Record<string, string> };

const failures: string[] = [];

async function placeholderFiles(directory: string): Promise<string[]> {
  const matches: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".wrangler") continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory())
      matches.push(...(await placeholderFiles(entryPath)));
    else if ((await readFile(entryPath, "utf8")).includes("our-org"))
      matches.push(path.relative(repository, entryPath));
  }
  return matches;
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version))
  failures.push(`invalid package version ${packageJson.version}`);
const cargoVersion = (
  await readFile(path.join(repository, "Cargo.toml"), "utf8")
).match(/^version = "([^"]+)"/m)?.[1];
if (cargoVersion !== packageJson.version)
  failures.push(
    `Cargo workspace version ${cargoVersion} does not match package version ${packageJson.version}`,
  );
if (manifest.schemaVersion !== 2)
  failures.push(
    `unsupported release manifest schema ${manifest.schemaVersion}`,
  );
if (!allowPlaceholder && manifest.releaseReady !== true)
  failures.push("release manifest has not been finalized by release:prepare");
if (manifest.version !== packageJson.version)
  failures.push(
    `release manifest version ${manifest.version} does not match package ${packageJson.version}`,
  );
const manifestKeys = Object.keys(manifest).sort().join(",");
if (manifestKeys !== "releaseReady,schemaVersion,version")
  failures.push(
    `release manifest must contain only schemaVersion, releaseReady and version, found ${manifestKeys}`,
  );
if (!allowPlaceholder && packageJson.name.includes("our-org"))
  failures.push("npm package name still contains the our-org placeholder");
if (!allowPlaceholder) {
  const placeholders = [
    ...(await placeholderFiles(path.join(repository, "cf-nix-cache-template"))),
    ...(await placeholderFiles(
      path.join(repository, "packages/worker"),
    )),
  ];
  if (placeholders.length > 0)
    failures.push(
      `release artifacts still contain our-org placeholders: ${placeholders.join(", ")}`,
    );
}
if (templatePackage.dependencies?.[packageJson.name] !== packageJson.version)
  failures.push(
    `template dependency must pin ${packageJson.name}@${packageJson.version}`,
  );

if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `release metadata: ${packageJson.name}@${packageJson.version}`,
  );
}

if (writeGithubOutput && failures.length === 0) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is not set");
  await appendFile(
    output,
    `package_name=${packageJson.name}\nversion=${packageJson.version}\n`,
  );
}
