import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd, against the real runtime: WebAssembly imports,
// DigestStream, R2 types and the other APIs the Worker relies on. The four
// SQLite-backed tests cannot run here, because workerd does not implement
// `node:sqlite`; they run in Node instead (see vitest.node.config.ts).
const SQLITE_TESTS = [
  'src/features/auth/durable/issuance.test.ts',
  'src/features/cache/durable/upload-allocations.test.ts',
  'src/features/gc/durable/ledger.test.ts',
  'src/features/gc/garbage-collection.test.ts',
];

// A throwaway Ed25519 key, committed so tests can sign narinfos. It never
// leaves the per-file isolated test storage.
const TEST_NIX_PRIVATE_JWK =
  '{"kty":"OKP","crv":"Ed25519","x":"SVHOT0rOqbiH6Yurx9i859O-gCv7874zL5Mz3gfT-0g","d":"uioj6p8CWenBnMLZrqu8M3RdXOx9gsvwtuXfwbjjuU4"}';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: '../../wrangler.jsonc' },
      miniflare: { bindings: { NIX_PRIVATE_JWK: TEST_NIX_PRIVATE_JWK } },
    }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
    exclude: SQLITE_TESTS,
  },
});
