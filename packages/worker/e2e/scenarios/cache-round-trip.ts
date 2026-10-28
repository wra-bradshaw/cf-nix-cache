import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect } from 'vitest';
import type { Cache, TokenResponse } from '../../src/generated/contracts';
import {
  clientStorePath,
  debugFixture,
  realScratchPath,
  type E2eFixture,
} from '../support/harness';
import { expectJson, jsonRequest, request } from '../support/http';
import {
  resolveZstd,
  repositoryDirectory,
  run,
  runAsync,
} from '../support/process';

const cacheName = 'e2e';
// execFileSync defaults to 1 MiB of output, less than most NARs.
const narBufferBytes = 1024 * 1024 * 1024;

export async function runCacheRoundTrip(fixture: E2eFixture): Promise<void> {
  const { server, base, bootstrapSecret, publicKey } = fixture;
  const zstd = resolveZstd();
  try {
    const unauthorized = await jsonRequest<Record<string, unknown>>(
      server,
      base,
      '/api/caches',
      { method: 'GET' },
    );
    expect(unauthorized.response.status).toBe(401);

    const admin = await expectJson<
      TokenResponse & { readonly repeated: boolean }
    >(server, base, '/api/bootstrap', 201, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': 'e2e-bootstrap',
      },
      body: JSON.stringify({
        secret: bootstrapSecret,
        subject: 'e2e-admin',
        valid_for_seconds: 3600,
        grants: [{ cache: '*', role: 'admin' }],
      }),
    });
    expect(admin.token).toEqual(expect.any(String));
    const authHeader = { authorization: `Bearer ${admin.token}` };

    await expectJson<Cache>(server, base, '/api/caches', 201, {
      method: 'POST',
      headers: {
        ...authHeader,
        'content-type': 'application/json',
        'Idempotency-Key': 'e2e-cache-create',
      },
      body: JSON.stringify({
        name: cacheName,
        public: true,
        quota_bytes: 10 * 1024 * 1024 * 1024,
      }),
    });
    const cacheInfo = await expectJson<Cache>(
      server,
      base,
      `/api/caches/${cacheName}`,
      200,
      { headers: authHeader },
    );
    expect(cacheInfo.name).toBe(cacheName);

    const hello = run('nix', [
      'build',
      '--no-link',
      '--print-out-paths',
      'nixpkgs#hello',
    ]).trim();
    expect(hello).toMatch(/^\/nix\/store\//);
    const cli = path.join(repositoryDirectory, 'target/debug/cf-nix-cache');
    await runAsync(cli, ['--endpoint', base, 'push', cacheName, hello], {
      env: {
        CF_NIX_CACHE_TOKEN: admin.token,
        XDG_CONFIG_HOME: path.join(fixture.scratch, 'config'),
      },
      stdio: 'inherit',
    });

    const pathInfo = JSON.parse(
      run('nix', ['path-info', '--json', hello]),
    ) as Record<string, unknown>;
    expect(pathInfo[hello]).toBeDefined();
    const storeHash = path.basename(hello).slice(0, 32);
    const narInfoResponse = await request(
      server,
      base,
      `/cache/${cacheName}/${storeHash}.narinfo`,
    );
    expect(narInfoResponse.status).toBe(200);
    const narInfo = await narInfoResponse.text();
    expect(narInfo).toMatch(/Compression: zstd/);
    expect(narInfo).toMatch(
      new RegExp(
        `^StorePath: ${hello.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
        'm',
      ),
    );
    expect(narInfo).toMatch(/^Sig: cache\.nix-signing:/m);

    const narPath = `/cache/${cacheName}/nar/${storeHash}.nar.zst`;
    const narResponse = await request(server, base, narPath);
    expect(narResponse.status).toBe(200);
    const encodedNar = Buffer.from(await narResponse.arrayBuffer());
    const decodedNar = execFileSync(zstd, ['-d', '-c'], {
      input: encodedNar,
      maxBuffer: narBufferBytes,
    });
    const expectedNar = execFileSync('nix-store', ['--dump', hello], {
      maxBuffer: narBufferBytes,
    });
    expect(decodedNar).toEqual(expectedNar);

    const rangeResponse = await request(server, base, narPath, {
      headers: { range: 'bytes=0-127' },
    });
    expect(rangeResponse.status).toBe(206);
    const rangedNar = Buffer.from(await rangeResponse.arrayBuffer());
    expect(rangedNar).toEqual(encodedNar.subarray(0, 128));
    const headResponse = await request(server, base, narPath, {
      method: 'HEAD',
    });
    expect(headResponse.status).toBe(200);
    expect((await headResponse.arrayBuffer()).byteLength).toBe(0);

    fixture.clientStore = clientStorePath(fixture);
    const clientStore = path.join(
      await realScratchPath(fixture),
      'client-store',
    );
    await runAsync(
      'nix',
      [
        'copy',
        '--from',
        `${base}/cache/${cacheName}?trusted=1`,
        '--to',
        clientStore,
        hello,
      ],
      {
        env: {
          NIX_CONFIG: `trusted-public-keys = ${publicKey}\nrequire-sigs = true\n`,
        },
        stdio: 'inherit',
      },
    );
    expect(
      run('nix', ['path-info', '--store', clientStore, hello]).trim(),
    ).toBe(hello);
    const copiedNar = execFileSync(
      'nix-store',
      ['--dump', '--store', clientStore, hello],
      { maxBuffer: narBufferBytes },
    );
    expect(copiedNar).toEqual(expectedNar);

    const secondPush = await runAsync(
      cli,
      ['--endpoint', base, 'push', cacheName, hello],
      {
        env: {
          CF_NIX_CACHE_TOKEN: admin.token,
          XDG_CONFIG_HOME: path.join(fixture.scratch, 'config-second'),
        },
      },
    );
    expect(secondPush).toMatch(/already cached/);
  } catch (error) {
    debugFixture(fixture);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message, { cause: error });
  }
}
