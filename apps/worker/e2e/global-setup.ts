import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);

export default async function globalSetup(): Promise<void> {
  const workerDirectory = resolve(import.meta.dirname, '..');
  const repositoryDirectory = resolve(workerDirectory, '../..');
  const configPath = resolve(repositoryDirectory, 'wrangler.jsonc');
  process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH = configPath;
  await execFileAsync(
    'pnpm',
    [
      'exec',
      'vite',
      'build',
      '--config',
      resolve(workerDirectory, 'vite.config.ts'),
    ],
    {
      cwd: workerDirectory,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}
