import { Hono } from 'hono';
import type { AppEnv } from './http';
import { handleError, errorResponse } from './error-handler';
import { controlRoutes } from '../control';
import { nixRoutes } from '../nix';
import { uploadRoutes } from '../uploads';

function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const id = crypto.randomUUID();
    c.set('requestId', id);
    c.header('x-request-id', id);
    await next();
  });

  app.route('', controlRoutes);
  app.route('', uploadRoutes);
  app.route('', nixRoutes);
  app.notFound((c) => errorResponse(c, 'not_found', 'route not found', 404));
  app.onError((caught, c) => handleError(caught, c));
  return app;
}

export const app = createApp();
