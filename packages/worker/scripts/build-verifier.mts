/**
 * Copies the Nix-built `crates/verify` wasm into src/generated/verify.wasm.
 * Rebuild before worker tests: `src/generated/` is gitignored, so a stale
 * `verify.wasm` may predate `crates/verify/src/ffi.rs`.
 *
 * The wasm is built by the `verifier` Nix package (crane, release profile);
 * this script only copies it into place so the file is writable.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = join(packageRoot, '../..');
const wasmPath = execFileSync(
  'nix',
  ['build', '.#verifier', '--no-link', '--print-out-paths'],
  { cwd: repositoryRoot, encoding: 'utf8' },
)
  .trim()
  .split(/\r?\n/)
  .at(-1);
if (!wasmPath) throw new Error('nix build .#verifier printed no path');
const generatedDir = join(packageRoot, 'src/generated');
mkdirSync(generatedDir, { recursive: true });
const destination = join(generatedDir, 'verify.wasm');
copyFileSync(join(wasmPath, 'verify.wasm'), destination);
chmodSync(destination, 0o644);
console.log('built the chunk verifier');
