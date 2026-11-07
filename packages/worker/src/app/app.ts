import { Hono } from 'hono';
import { auditRoutes } from '../features/audit/routes';
import { tokenRoutes } from '../features/auth/routes';
import { pathRoutes } from '../features/cache/path-routes';
import { cacheRoutes } from '../features/cache/routes';
import { gcRoutes } from '../features/gc/routes';
import { nixRoutes } from '../features/nix/routes';
import { uploadRoutes } from '../features/uploads/routes';
import type { AppEnv } from '../shared/http';
import { errorResponse, handleError } from './error-handler';

function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const id = crypto.randomUUID();
    c.set('requestId', id);
    c.header('x-request-id', id);
    await next();
  });

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.route('', tokenRoutes);
  app.route('', auditRoutes);
  app.route('', cacheRoutes);
  app.route('', pathRoutes);
  app.route('', gcRoutes);
  app.route('', uploadRoutes);
  app.route('', nixRoutes);
  app.notFound((c) => errorResponse(c, 'not_found', 'route not found', 404));
  app.onError((caught, c) => handleError(caught, c));
  return app;
}

export const app = createApp();
