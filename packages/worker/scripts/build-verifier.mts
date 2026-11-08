/**
 * Builds `crates/verify` for wasm32 into src/generated/verify.wasm, which the
 * Worker imports. Needs the dev shell's Rust toolchain and lld.
 *
 * Run this (`pnpm generate`) before the worker tests: `src/generated/` is
 * gitignored, so without a rebuild the tests would exercise whatever local
 * `verify.wasm` happens to be there, which may predate the current
 * `crates/verify/src/ffi.rs`. The `pretest`, `precheck`, `prebuild`,
 * `predev`, and `pree2e` scripts in `packages/worker/package.json` all run
 * `pnpm generate` for this reason. `ChunkVerifier` also asserts the wasm
 * exports exist at startup so a stale module fails fast with a rebuild hint.
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
