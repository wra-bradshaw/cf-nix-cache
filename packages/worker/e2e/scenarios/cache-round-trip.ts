import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect } from 'vitest';
import type {
  Cache,
  GcRunRequest,
  GcRunResponse,
  GcStatusResponse,
  TokenResponse,
} from '../../src/generated/contracts';
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
    expect(cacheInfo.upstream_cache_key_names).toEqual(['cache.nixos.org-1']);
    // Whether hello is signed upstream depends on how this machine got it.
    const pushAll = ['push', '--ignore-upstream-cache-filter'];
    await runAsync(cli, ['--endpoint', base, ...pushAll, cacheName, hello], {
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
      ['--endpoint', base, ...pushAll, cacheName, hello],
      {
        env: {
          CF_NIX_CACHE_TOKEN: admin.token,
          XDG_CONFIG_HOME: path.join(fixture.scratch, 'config-second'),
        },
      },
    );
    expect(secondPush).toMatch(/already cached/);

    const retained = await expectJson<Cache>(
      server,
      base,
      `/api/caches/${cacheName}/config`,
      200,
      {
        method: 'PATCH',
        headers: {
          ...authHeader,
          'content-type': 'application/json',
          'Idempotency-Key': 'e2e-cache-retention',
        },
        body: JSON.stringify({ retention_days: 30 }),
      },
    );
    expect(retained.retention_days).toBe(30);
    expect(retained.public).toBe(true);

    const runGc = async (key: string, body: GcRunRequest) => {
      const { run_id } = await expectJson<GcRunResponse>(
        server,
        base,
        '/api/gc',
        202,
        {
          method: 'POST',
          headers: {
            ...authHeader,
            'content-type': 'application/json',
            'Idempotency-Key': key,
          },
          body: JSON.stringify(body),
        },
      );
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        const status = await expectJson<GcStatusResponse>(
          server,
          base,
          '/api/gc',
          200,
          { headers: authHeader },
        );
        if (status.last_run?.run_id === run_id) return status.last_run;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error(`garbage collection run ${run_id} did not finish`);
    };

    // Everything pushed is live, so collecting must not remove any of it.
    const idle = await runGc('e2e-gc-idle', { grace_seconds: 0 });
    expect(idle).toMatchObject({ outcome: 'success', deleted_objects: 0 });
    expect(idle.marked_objects).toBeGreaterThan(0);
    expect((await request(server, base, narPath)).status).toBe(200);

    const deleted = await request(
      server,
      base,
      `/api/caches/${cacheName}/paths/${storeHash}`,
      {
        method: 'DELETE',
        headers: { ...authHeader, 'Idempotency-Key': 'e2e-path-delete' },
      },
    );
    expect(deleted.status).toBe(200);

    const preview = await runGc('e2e-gc-preview', {
      dry_run: true,
      grace_seconds: 0,
    });
    expect(preview.dry_run).toBe(true);
    expect(preview.deleted_objects).toBeGreaterThan(0);

    const swept = await runGc('e2e-gc-sweep', { grace_seconds: 0 });
    expect(swept).toMatchObject({
      outcome: 'success',
      dry_run: false,
      deleted_objects: preview.deleted_objects,
      missing_manifests: 0,
    });

    // The manifest and chunks are gone, so a push has to rebuild them rather
    // than trust what deduplication would have found before.
    await runAsync(cli, ['--endpoint', base, ...pushAll, cacheName, hello], {
      env: {
        CF_NIX_CACHE_TOKEN: admin.token,
        XDG_CONFIG_HOME: path.join(fixture.scratch, 'config-third'),
      },
    });
    const restored = await request(server, base, narPath);
    expect(restored.status).toBe(200);
    expect(
      execFileSync(zstd, ['-d', '-c'], {
        input: Buffer.from(await restored.arrayBuffer()),
        maxBuffer: narBufferBytes,
      }),
    ).toEqual(expectedNar);

    // With no upstreams configured, a plain push uploads everything.
    const secondCache = 'e2e-delete';
    const createSecondCache = (key: string) =>
      expectJson<Cache>(server, base, '/api/caches', 201, {
        method: 'POST',
        headers: {
          ...authHeader,
          'content-type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({
          name: secondCache,
          quota_bytes: 10 * 1024 * 1024 * 1024,
          upstream_cache_key_names: [],
        }),
      });
    const second = await createSecondCache('e2e-delete-create');
    expect(second.upstream_cache_key_names).toEqual([]);
    const upstreams = await expectJson<{
      upstream_cache_key_names: string[];
    }>(server, base, `/api/caches/${secondCache}/upstreams`, 200, {
      headers: authHeader,
    });
    expect(upstreams.upstream_cache_key_names).toEqual([]);
    await runAsync(cli, ['--endpoint', base, 'push', secondCache, hello], {
      env: {
        CF_NIX_CACHE_TOKEN: admin.token,
        XDG_CONFIG_HOME: path.join(fixture.scratch, 'config-fourth'),
      },
    });
    const secondNarInfo = `/cache/${secondCache}/${storeHash}.narinfo`;
    expect(
      (await request(server, base, secondNarInfo, { headers: authHeader }))
        .status,
    ).toBe(200);

    // Deleting a cache clears all of its shards and finishes. The new cache
    // gets a new identity, so it must start out empty.
    const deleting = await request(server, base, `/api/caches/${secondCache}`, {
      method: 'DELETE',
      headers: { ...authHeader, 'Idempotency-Key': 'e2e-delete-delete' },
    });
    expect(deleting.status).toBe(202);
    const deleteDeadline = Date.now() + 10 * 60 * 1000;
    while (true) {
      const lookup = await request(server, base, `/api/caches/${secondCache}`, {
        headers: authHeader,
      });
      if (lookup.status === 404) break;
      if (Date.now() > deleteDeadline)
        throw new Error('cache deletion did not finish');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await createSecondCache('e2e-delete-recreate');
    expect(
      (await request(server, base, secondNarInfo, { headers: authHeader }))
        .status,
    ).toBe(404);
  } catch (error) {
    debugFixture(fixture);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message, { cause: error });
  }
}
