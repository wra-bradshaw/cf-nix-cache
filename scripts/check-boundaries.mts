import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = join(root, "packages/worker/src");
const featureRoot = join(workerSource, "features");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : [path];
    }),
  );
  return nested.flat();
}

const allSourceFiles = await sourceFiles(workerSource);
const sourceSet = new Set(allSourceFiles);
const implementationFiles = allSourceFiles.filter(
  (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
);

const pureFiles = implementationFiles.filter((file) => {
  const relativeFile = relative(featureRoot, file);
  return (
    relativeFile.startsWith(
      `domain${process.platform === "win32" ? "\\" : "/"}`,
    ) ||
    relativeFile === "auth/authorization.ts" ||
    relativeFile === "cache/application.ts" ||
    relativeFile === "cache/ports.ts" ||
    // Application services and port definitions are pure by convention. Keep
    // this structural so a new feature cannot bypass the boundary check just
    // by choosing a different feature directory.
    /(?:^|[\\/])(application|ports)(?:\.[^\\/]*)?\.ts$/u.test(relativeFile)
  );
});

const forbidden =
  /(?:cloudflare:workers|@cloudflare|DurableObject|R2Bucket|\bfetch\s*\()/;
const importSpecifier = /(?:from|import)\s*["']([^"']+)["']/g;

function isWithin(path: string, directory: string): boolean {
  const value = relative(directory, path);
  return value === "" || (!value.startsWith("..") && !value.startsWith("/"));
}

function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier.replace(/\.js$/u, ".ts"));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.mts`,
    join(base, "index.ts"),
  ];
  return candidates.find((candidate) => sourceSet.has(candidate)) ?? null;
}

for (const file of pureFiles) {
  const source = await readFile(file, "utf8");
  if (forbidden.test(source))
    throw new Error(`${relative(root, file)} uses an infrastructure API`);

  for (const match of source.matchAll(importSpecifier)) {
    const target = resolveImport(file, match[1]);
    if (target && isWithin(featureRoot, target) && !pureFiles.includes(target))
      throw new Error(
        `${relative(root, file)} imports infrastructure-owned module ${relative(root, target)}`,
      );
  }
}

for (const file of allSourceFiles.filter((value) =>
  value.endsWith(".test.ts"),
)) {
  const implementation = file.slice(0, -".test.ts".length) + ".ts";
  if (!sourceSet.has(implementation))
    throw new Error(
      `${relative(root, file)} must be colocated with ${basename(implementation)}`,
    );
}

const integrationEntry = await readFile(
  join(root, "packages/worker/e2e/integration.test.ts"),
  "utf8",
);
if (/createTestHarness|execFileSync/.test(integrationEntry))
  throw new Error(
    "e2e/integration.test.ts should declare scenarios, not implement the harness",
  );

console.log(
  `feature boundaries passed for ${pureFiles.length} structurally checked pure modules and colocated unit tests`,
);
