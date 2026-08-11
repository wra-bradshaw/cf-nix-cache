import { defineConfig } from 'vitest/config';
import { jsonContracts } from './build/json-contracts';

export default defineConfig({
  plugins: [jsonContracts()],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
