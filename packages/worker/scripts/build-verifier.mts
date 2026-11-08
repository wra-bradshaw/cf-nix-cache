/**
 * Builds `crates/verify` for wasm32 into src/generated/verify.wasm.
 * Rebuild before worker tests: `src/generated/` is gitignored, so a stale
 * `verify.wasm` may predate `crates/verify/src/ffi.rs`.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = join(packageRoot, '../..');
execFileSync(
  'cargo',
  [
    'build',
    '--quiet',
    '--release',
    '--package',
    'cf-nix-cache-verify',
    '--target',
    'wasm32-unknown-unknown',
  ],
  { cwd: repositoryRoot, stdio: 'inherit' },
);
mkdirSync(join(packageRoot, 'src/generated'), { recursive: true });
copyFileSync(
  join(
    repositoryRoot,
    'target/wasm32-unknown-unknown/release/cf_nix_cache_verify.wasm',
  ),
  join(packageRoot, 'src/generated/verify.wasm'),
);
console.log('built the chunk verifier');
