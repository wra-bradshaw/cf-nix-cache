import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const workerDirectory = path.resolve(import.meta.dirname, '../..');
export const repositoryDirectory = path.resolve(workerDirectory, '../..');

type RunOptions = {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio?: 'pipe' | 'inherit';
};

export function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): string {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repositoryDirectory,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
  }) as string;
}

export function resolveZstd(): string {
  try {
    run('zstd', ['--version']);
    return 'zstd';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const packagePath = run('nix', [
      'build',
      '--no-link',
      '--print-out-paths',
      'nixpkgs#zstd',
    ])
      .trim()
      .split(/\r?\n/)
      .find((candidate) => path.basename(candidate).endsWith('-bin'));
    if (!packagePath)
      throw new Error('nixpkgs#zstd did not expose a binary output', {
        cause: error,
      });
    return path.join(packagePath, 'bin/zstd');
  }
}
