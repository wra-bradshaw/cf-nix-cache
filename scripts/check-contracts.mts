import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = (await readdir(join(root, "schemas"))).filter((file) =>
  file.endsWith(".json"),
);
for (const file of files) {
  const value = JSON.parse(await readFile(join(root, "schemas", file), "utf8"));
  if (
    !value.$id ||
    value.$schema !== "https://json-schema.org/draft/2020-12/schema"
  )
    throw new Error(`${file} is not a draft 2020-12 schema`);
}
const generated = await readFile(
  join(root, "apps/worker/src/generated/contracts.ts"),
  "utf8",
);
if (!generated.includes("GENERATED FROM schemas/*.json"))
  throw new Error("worker contracts are not marked generated");
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "cf-nix-contracts-"));
const temporaryFile = join(temporaryDirectory, "contracts.ts");
const temporaryRuntimeFile = join(temporaryDirectory, "json-contracts.ts");
try {
  await promisify(execFile)(
    "node",
    [
      join(root, "scripts/generate-contracts.mts"),
      "--output",
      temporaryFile,
      "--runtime-output",
      temporaryRuntimeFile,
    ],
    { cwd: root },
  );
  const regenerated = await readFile(temporaryFile, "utf8");
  if (regenerated !== generated)
    throw new Error("generated contracts are stale; run contracts:generate");
  const generatedRuntime = await readFile(
    join(root, "apps/worker/src/generated/json-contracts.ts"),
    "utf8",
  );
  const regeneratedRuntime = await readFile(temporaryRuntimeFile, "utf8");
  if (regeneratedRuntime !== generatedRuntime)
    throw new Error(
      "generated runtime contracts are stale; run contracts:generate",
    );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
console.log(
  `validated and deterministically regenerated ${files.length} JSON Schemas`,
);
