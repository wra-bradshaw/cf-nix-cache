// Lays out the published npm package after `vite build`. Templates resolve the
// package version from `dist/..`, so the entry must stay at `dist/index.js`
// rather than the Vite environment directory `dist/cf_nix_cache/`.
import { cp, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(packageDirectory, 'dist');
const workerOutput = resolve(outputDirectory, 'cf_nix_cache');

await cp(
  resolve(workerOutput, 'index.js'),
  resolve(outputDirectory, 'index.js'),
);
await cp(
  resolve(workerOutput, 'index.js.map'),
  resolve(outputDirectory, 'index.js.map'),
);

// Wrangler only needs the runtime exports. The declaration names them without
// depending on the monorepo's generated Worker types, so a consumer's
// `export * from "cf-nix-cache"` type-checks against the real export list.
const exportedClasses = [
  'AuditLog',
  'CacheCoordinator',
  'CacheIndexShard',
  'ContainerProxy',
  'DeleteCacheWorkflow',
  'ProcessorContainer',
  'ProcessUploadWorkflow',
  'SystemControl',
  'TokenCatalog',
  'UploadJob',
];
await writeFile(
  resolve(outputDirectory, 'index.d.ts'),
  [
    'declare const worker: {',
    '  fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;',
    '};',
    'export default worker;',
    ...exportedClasses.map((name) => `export declare class ${name} {}`),
    '',
  ].join('\n'),
);

const packageJson = JSON.parse(
  await readFile(resolve(packageDirectory, 'package.json'), 'utf8'),
);
const releaseManifest = JSON.parse(
  await readFile(resolve(packageDirectory, 'release-manifest.json'), 'utf8'),
);
if (releaseManifest.version !== packageJson.version) {
  throw new Error(
    `release manifest ${releaseManifest.version} does not match package ${packageJson.version}`,
  );
}
if (
  typeof releaseManifest.processorImage !== 'string' ||
  !/^docker\.io\/.+@sha256:[0-9a-f]{64}$/.test(releaseManifest.processorImage)
) {
  throw new Error(
    'release manifest processorImage must be an immutable docker.io digest reference',
  );
}
