import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonContracts } from "../packages/worker/build/json-contracts.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { compile } = await import(
  `${join(root, "packages/worker/node_modules/json-schema-to-typescript/dist/src/index.js")}`
);
const prettierModule = await import(
  `${join(root, "packages/worker/node_modules/prettier/index.cjs")}`
);
const format = prettierModule.format ?? prettierModule.default.format;
const schemaDir = join(root, "schemas");
const files = (await readdir(schemaDir))
  .filter((file) => file.endsWith(".json"))
  .sort();
const output = [
  "// GENERATED FROM schemas/*.json. Do not edit by hand.",
  "// Regenerate with: pnpm --dir packages/worker contracts:generate",
  "",
];
for (const file of files) {
  const schema = JSON.parse(await readFile(join(schemaDir, file), "utf8"));
  const types = await compile(
    schema,
    basename(file, ".json").replace(/(^|-)(.)/g, (_, _dash, character) =>
      character.toUpperCase(),
    ),
    {
      bannerComment: "",
      format: false,
      unreachableDefinitions: true,
    },
  );
  output.push(`// Source: schemas/${file}`, types.trim(), "");
}
const outputFlagIndex = process.argv.indexOf("--output");
const outputPath =
  outputFlagIndex >= 0
    ? process.argv[outputFlagIndex + 1]
    : join(root, "packages/worker/src/generated/contracts.ts");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  await format(`${output.join("\n")}\n`, {
    parser: "typescript",
    singleQuote: true,
    trailingComma: "all",
  }),
);
const runtimeOutputFlagIndex = process.argv.indexOf("--runtime-output");
if (outputFlagIndex < 0 || runtimeOutputFlagIndex >= 0) {
  const runtimeOutputPath =
    runtimeOutputFlagIndex >= 0
      ? process.argv[runtimeOutputFlagIndex + 1]
      : join(root, "packages/worker/src/generated/json-contracts.ts");
  writeJsonContracts(join(root, "schemas"), runtimeOutputPath);
}
console.log(`generated TypeScript contracts for ${files.length} schemas`);
