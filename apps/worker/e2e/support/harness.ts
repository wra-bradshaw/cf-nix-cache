import { mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createTestHarness, type TestHarness } from 'wrangler';
import { hashSecret, keyMaterial, nixPublicKey } from './crypto';
import {
  repositoryDirectory,
  resolveZstd,
  run,
  workerDirectory,
} from './process';

const keepArtifacts = process.env.CF_NIX_CACHE_KEEP_ARTIFACTS === '1';

export type E2eFixture = {
  readonly server: TestHarness;
  readonly base: string;
  readonly scratch: string;
  readonly bootstrapSecret: string;
  readonly publicKey: string;
  clientStore?: string;
};

function generatedWranglerConfig(): string {
  return path.resolve(workerDirectory, 'dist/cf_nix_cache/wrangler.json');
}

export async function createFixture(): Promise<E2eFixture> {
  for (const command of ['nix', 'nix-store', 'cargo'])
    run(command, ['--version']);
  run('docker', ['--version']);
  resolveZstd();

  const scratch = await mkdtemp(path.join(tmpdir(), 'cf-nix-cache-e2e-'));
  const auth = keyMaterial();
  const nix = keyMaterial();
  const bootstrapSecret = `e2e-${randomUUID()}`;
  const publicKey = nixPublicKey('cache.nix-signing', nix.publicJwk);
  const vars = {
    AUTH_PRIVATE_JWK: JSON.stringify(auth.privateJwk),
    AUTH_PUBLIC_JWKS: JSON.stringify([{ kid: 'current', jwk: auth.publicJwk }]),
    NIX_PRIVATE_JWK: JSON.stringify(nix.privateJwk),
    NIX_SIGNING_KEY_NAME: 'cache.nix-signing',
    NIX_PUBLIC_KEYS: publicKey,
    BOOTSTRAP_SECRET_HASH: hashSecret(bootstrapSecret),
    TOKEN_ISSUER: 'cf-nix-cache-e2e',
    TOKEN_AUDIENCE: 'cf-nix-cache-e2e',
  };
  const server = createTestHarness({
    root: repositoryDirectory,
    workers: [{ configPath: generatedWranglerConfig(), vars }],
  });
  const initial = await server.listen();
  run('cargo', ['build', '-q', '-p', 'cf-nix-cache']);
  return {
    server,
    base: initial.url.origin,
    scratch,
    bootstrapSecret,
    publicKey,
  };
}

export async function closeFixture(fixture: E2eFixture): Promise<void> {
  try {
    await fixture.server.close();
  } finally {
    if (fixture.scratch && !keepArtifacts) {
      if (fixture.clientStore) {
        try {
          run('chmod', ['-R', 'u+w', fixture.clientStore]);
        } catch {
          // Best-effort cleanup for Nix store files.
        }
      }
      await rm(fixture.scratch, { recursive: true, force: true });
    } else console.log(`kept e2e artifacts at ${fixture.scratch}`);
  }
}

export function debugFixture(fixture: E2eFixture): void {
  fixture.server.debug();
}

export function clientStorePath(fixture: E2eFixture): string {
  return path.join(fixture.scratch, 'client-store');
}

export async function realScratchPath(fixture: E2eFixture): Promise<string> {
  return realpath(fixture.scratch);
}
