/**
 * Generates src/generated/{contracts,json-contracts}.ts from schemas/*.json.
 * With `--check`, regenerates into a temporary directory and fails if the
 * output differs from the files already in src/generated (stale or
 * non-deterministic generation).
 */
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';
import { format } from 'prettier';
import { writeJsonContracts } from '../build/json-contracts.ts';

const packageRoot = join(fileURLToPath(import.meta.url), '../..');
const schemaDir = join(packageRoot, '../../schemas');
const generatedDir = join(packageRoot, 'src/generated');
const outputs = ['contracts.ts', 'json-contracts.ts'];
const check = process.argv.includes('--check');

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

const outputDir = check
  ? await mkdtemp(join(tmpdir(), 'cf-nix-contracts-'))
  : generatedDir;
await mkdir(outputDir, { recursive: true });
await writeFile(
  join(outputDir, 'contracts.ts'),
  await format(`${output.join('\n')}\n`, {
    parser: 'typescript',
    singleQuote: true,
    trailingComma: 'all',
  }),
);
writeJsonContracts(schemaDir, join(outputDir, 'json-contracts.ts'));

if (check) {
  const stale: string[] = [];
  for (const name of outputs) {
    const expected = await readFile(join(outputDir, name), 'utf8');
    const actual = await readFile(join(generatedDir, name), 'utf8').catch(
      () => undefined,
    );
    if (actual !== expected) stale.push(name);
  }
  await rm(outputDir, { recursive: true, force: true });
  if (stale.length > 0) {
    console.error(
      `src/generated/${stale.join(', ')} differ from a fresh generation; run \`pnpm generate\` or make the generator deterministic`,
    );
    process.exit(1);
  }
  console.log(`generated contracts are up to date (${files.length} schemas)`);
} else {
  console.log(`generated TypeScript contracts for ${files.length} schemas`);
}
