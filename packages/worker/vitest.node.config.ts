import { defineConfig } from 'vitest/config';

// workerd does not implement `node:sqlite`, so the tests that back the
// durable helpers with a real in-memory SQLite database run in Node. They
// still exercise the production SQL through node:sqlite's SQLite.
export default defineConfig({
  plugins: [
    {
      // workerd imports a .wasm file as a compiled WebAssembly.Module; Node
      // needs this to do the same.
      name: 'wasm-module',
      enforce: 'pre',
      load(id) {
        if (!id.endsWith('.wasm')) return;
        return `import { readFileSync } from 'node:fs';
export default new WebAssembly.Module(readFileSync(${JSON.stringify(id)}));`;
      },
    },
  ],
  test: {
    include: [
      'src/features/auth/durable/issuance.test.ts',
      'src/features/cache/durable/upload-allocations.test.ts',
      'src/features/gc/durable/ledger.test.ts',
      'src/features/gc/garbage-collection.test.ts',
    ],
    environment: 'node',
  },
});
