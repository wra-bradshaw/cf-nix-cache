import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = join(packageRoot, '../../schemas');
const files = (await readdir(schemaDir)).filter((file) =>
  file.endsWith('.json'),
);
for (const file of files) {
  const value = JSON.parse(await readFile(join(schemaDir, file), 'utf8'));
  if (
    !value.$id ||
    value.$schema !== 'https://json-schema.org/draft/2020-12/schema'
  )
    throw new Error(`${file} is not a draft 2020-12 schema`);
}
const generated = await readFile(
  join(packageRoot, 'src/generated/contracts.ts'),
  'utf8',
);
if (!generated.includes('GENERATED FROM schemas/*.json'))
  throw new Error('worker contracts are not marked generated');
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'cf-nix-contracts-'));
const temporaryFile = join(temporaryDirectory, 'contracts.ts');
const temporaryRuntimeFile = join(temporaryDirectory, 'json-contracts.ts');
try {
  await promisify(execFile)(
    'node',
    [
      join(packageRoot, 'scripts/generate-contracts.mts'),
      '--output',
      temporaryFile,
      '--runtime-output',
      temporaryRuntimeFile,
    ],
    { cwd: packageRoot },
  );
  const regenerated = await readFile(temporaryFile, 'utf8');
  if (regenerated !== generated)
    throw new Error('generated contracts are stale; run contracts:generate');
  const generatedRuntime = await readFile(
    join(packageRoot, 'src/generated/json-contracts.ts'),
    'utf8',
  );
  const regeneratedRuntime = await readFile(temporaryRuntimeFile, 'utf8');
  if (regeneratedRuntime !== generatedRuntime)
    throw new Error(
      'generated runtime contracts are stale; run contracts:generate',
    );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
console.log(
  `validated and deterministically regenerated ${files.length} JSON Schemas`,
);
