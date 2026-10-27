import { Hono } from 'hono';
import type { AppEnv } from '../runtime/http';
import { cacheRoutes } from './caches';
import { pathRoutes } from './paths';
import { tokenRoutes } from './tokens';

export const controlRoutes = new Hono<AppEnv>();

controlRoutes.get('/health', (c) => c.json({ status: 'ok' }));

controlRoutes.get(
  '/api/public-key',
  (c) =>
    new Response(`${c.env.NIX_PUBLIC_KEYS.trim()}\n`, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=300',
      },
    }),
);

controlRoutes.route('', tokenRoutes);
controlRoutes.route('', cacheRoutes);
controlRoutes.route('', pathRoutes);
