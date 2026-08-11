import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import { jsonContracts } from './build/json-contracts';

const defaultWranglerConfig = fileURLToPath(
  new URL('../../wrangler.jsonc', import.meta.url),
);

export default defineConfig({
  plugins: [
    jsonContracts(),
    cloudflare({
      configPath:
        process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH ??
        defaultWranglerConfig,
    }),
  ],
  build: {
    sourcemap: true,
  },
});
