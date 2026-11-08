import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';
import { format } from 'prettier';
import { writeJsonContracts } from '../build/json-contracts.ts';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = join(packageRoot, '../../schemas');
const files = (await readdir(schemaDir))
  .filter((file) => file.endsWith('.json'))
  .sort();
const output = [
  '// GENERATED FROM schemas/*.json. Do not edit by hand.',
  '// Regenerate with: pnpm --dir packages/worker generate',
  '',
];
for (const file of files) {
  const schema = JSON.parse(await readFile(join(schemaDir, file), 'utf8'));
  if (
    !schema.$id ||
    schema.$schema !== 'https://json-schema.org/draft/2020-12/schema'
  )
    throw new Error(`${file} is not a draft 2020-12 schema`);
  const types = await compile(
    schema,
    basename(file, '.json').replace(/(^|-)(.)/g, (_, _dash, character) =>
      character.toUpperCase(),
    ),
    {
      bannerComment: '',
      format: false,
      unreachableDefinitions: true,
    },
  );
  output.push(`// Source: schemas/${file}`, types.trim(), '');
}
const outputFlagIndex = process.argv.indexOf('--output');
const outputPath =
  outputFlagIndex >= 0
    ? process.argv[outputFlagIndex + 1]
    : join(packageRoot, 'src/generated/contracts.ts');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  await format(`${output.join('\n')}\n`, {
    parser: 'typescript',
    singleQuote: true,
    trailingComma: 'all',
  }),
);
const runtimeOutputFlagIndex = process.argv.indexOf('--runtime-output');
if (outputFlagIndex < 0 || runtimeOutputFlagIndex >= 0) {
  const runtimeOutputPath =
    runtimeOutputFlagIndex >= 0
      ? process.argv[runtimeOutputFlagIndex + 1]
      : join(packageRoot, 'src/generated/json-contracts.ts');
  writeJsonContracts(schemaDir, runtimeOutputPath);
}
console.log(`generated TypeScript contracts for ${files.length} schemas`);
