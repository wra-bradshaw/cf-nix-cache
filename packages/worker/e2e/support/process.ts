import { execFileSync, spawn } from 'node:child_process';
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

// Use for commands that talk to the Worker. execFileSync blocks the event
// loop, so miniflare cannot expire its pooled sockets to workerd and the next
// harness request reuses one that workerd has already closed.
export function runAsync(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryDirectory,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', options.stdio ?? 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (options.stdio === 'inherit') process.stdout.write(chunk);
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(
            `Command failed (${signal ?? `exit ${code}`}): ${command} ${args.join(' ')}\n${stderr}`,
          ),
        );
    });
  });
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
