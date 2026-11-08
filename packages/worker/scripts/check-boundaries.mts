import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(packageRoot, 'src');
const sharedRoot = join(source, 'shared');
const featureRoot = join(source, 'features');
const appRoot = join(source, 'app');
const generatedRoot = join(source, 'generated');

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

function isWithin(path: string, directory: string): boolean {
  const value = relative(directory, path);
  return value === '' || (!value.startsWith('..') && !value.startsWith(sep));
}

const allSourceFiles = await sourceFiles(source);
const sourceSet = new Set(allSourceFiles);
const testFiles = allSourceFiles.filter((file) => file.endsWith('.test.ts'));
const implementationFiles = allSourceFiles.filter(
  (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
);

const impureSharedModules = new Set([
  'http.ts',
  'rpc.ts',
  'sql.ts',
  'rpc-only-durable-object.ts',
  'workflows.ts',
  'test-fixtures.ts',
]);
const pureFeatureModules = new Set([
  'auth/authorization.ts',
  'cache/publication-protocol.ts',
  'cache/shards.ts',
  'gc/garbage-collection.ts',
  'gc/gc-ports.ts',
  'uploads/manifest.ts',
]);

const pureFiles = new Set(
  implementationFiles.filter((file) => {
    if (isWithin(file, sharedRoot))
      return !impureSharedModules.has(relative(sharedRoot, file));
    if (!isWithin(file, featureRoot)) return false;
    return (
      pureFeatureModules.has(relative(featureRoot, file)) ||
      basename(file) === 'types.ts'
    );
  }),
);

const forbidden =
  /(?:cloudflare:workers|@cloudflare|DurableObject|R2Bucket|\bfetch\s*\()/;
const importSpecifier = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.mts`,
    join(base, 'index.ts'),
  ];
  const target = candidates.find((candidate) => sourceSet.has(candidate));
  if (!target)
    throw new Error(
      `${relative(packageRoot, from)} imports unresolvable module ${specifier}`,
    );
  return target;
}

const problems: string[] = [];
const label = (file: string) => relative(packageRoot, file);

for (const file of allSourceFiles) {
  const text = await readFile(file, 'utf8');
  const isGenerated = isWithin(file, generatedRoot);
  if (isGenerated) continue;

  if (pureFiles.has(file) && forbidden.test(text))
    problems.push(`${label(file)} is pure but uses an infrastructure API`);

  for (const match of text.matchAll(importSpecifier)) {
    const target = resolveImport(file, match[1]);
    if (!target) continue;
    if (
      pureFiles.has(file) &&
      !pureFiles.has(target) &&
      !isWithin(target, generatedRoot)
    )
      problems.push(
        `${label(file)} is pure but imports non-pure module ${label(target)}`,
      );
    if (
      isWithin(file, sharedRoot) &&
      (isWithin(target, featureRoot) || isWithin(target, appRoot))
    )
      problems.push(`${label(file)} is shared but imports ${label(target)}`);
    if (isWithin(file, featureRoot) && isWithin(target, appRoot))
      problems.push(`${label(file)} is a feature but imports ${label(target)}`);
  }
}

for (const file of testFiles) {
  const implementation = file.slice(0, -'.test.ts'.length) + '.ts';
  if (!sourceSet.has(implementation))
    problems.push(
      `${label(file)} must be colocated with ${basename(implementation)}`,
    );
}

const integrationEntry = await readFile(
  join(packageRoot, 'e2e/integration.test.ts'),
  'utf8',
);
if (/createTestHarness|execFileSync/.test(integrationEntry))
  problems.push(
    'e2e/integration.test.ts should declare scenarios, not implement the harness',
  );

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}

console.log(
  `feature boundaries passed for ${pureFiles.size} pure modules, ${testFiles.length} colocated unit tests, and the shared/feature/app dependency direction`,
);
