import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    globalSetup: ['./e2e/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 15 * 60 * 1000,
    hookTimeout: 15 * 60 * 1000,
  },
});
