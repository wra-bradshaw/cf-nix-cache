import { appendFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const allowPlaceholder = process.argv.includes("--allow-placeholder");
const allowZeroDigest =
  allowPlaceholder || process.argv.includes("--allow-zero-digest");
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
  processorImage: string;
  platform: string;
};
const templatePackage = JSON.parse(
  await readFile(
    path.join(repository, "cf-nix-cache-template/package.json"),
    "utf8",
  ),
) as { dependencies?: Record<string, string> };
const wrangler = await readFile(
  path.join(repository, "cf-nix-cache-template/wrangler.jsonc"),
  "utf8",
);

const failures: string[] = [];
const imagePattern =
  /^docker\.io\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;
const zeroDigest = /@sha256:0{64}$/;

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
if (manifest.schemaVersion !== 1)
  failures.push(
    `unsupported release manifest schema ${manifest.schemaVersion}`,
  );
if (!allowZeroDigest && manifest.releaseReady !== true)
  failures.push(
    "release manifest has not been finalized by the artifact workflow",
  );
if (manifest.version !== packageJson.version)
  failures.push(
    `release manifest version ${manifest.version} does not match package ${packageJson.version}`,
  );
if (manifest.platform !== "linux/amd64")
  failures.push(`unsupported processor platform ${manifest.platform}`);
if (!imagePattern.test(manifest.processorImage))
  failures.push("processor image must be an immutable docker.io digest");
if (!allowZeroDigest && zeroDigest.test(manifest.processorImage))
  failures.push("processor image still contains the zero-digest placeholder");
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
if (!wrangler.includes(`"PROCESSOR_IMAGE": "${manifest.processorImage}"`))
  failures.push("template Wrangler image does not match the release manifest");

if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `release metadata: ${packageJson.name}@${packageJson.version} -> ${manifest.processorImage}`,
  );
}

if (writeGithubOutput && failures.length === 0) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is not set");
  await appendFile(
    output,
    `package_name=${packageJson.name}\nversion=${packageJson.version}\nimage=${manifest.processorImage}\n`,
  );
}
