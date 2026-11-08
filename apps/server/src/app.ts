/**
 * The Hono app: CORS, error handling, /api/health, and every router mounted at /api.
 * Implemented by: server-core.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { HealthResponse } from '@pacepay/shared';
import type { ServerContext } from './context';
import { HttpError, apiError } from './api/http';
import { householdRoutes } from './api/household';
import { threadRoutes } from './api/thread';
import { caseRoutes } from './api/cases';
import { demoRoutes } from './api/demo';
import { negotiationRoutes } from './api/negotiations';
import { voiceRoutes } from './api/voice';
import { eventRoutes } from './api/events';
import { arenaRoutes } from './api/arena';
import { mediaRoutes } from './api/media';
import { dashboardUrl } from './env';

export function createApp(ctx: ServerContext): Hono {
  const app = new Hono();

  const origins = new Set([dashboardUrl(), 'http://localhost:3000', 'https://pacepay.work', 'https://www.pacepay.work']);
  app.use(
    '/api/*',
    cors({
      origin: (origin) => (origins.has(origin) || origin.endsWith('.vercel.app') ? origin : null),
      allowHeaders: ['Content-Type', 'Last-Event-ID'],
      allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    }),
  );

  app.onError((err, c) => {
    if (err instanceof HttpError) return apiError(c, err.status, err.code, err.message);
    const code = (err as { code?: string }).code;
    if (code === 'not_found') return apiError(c, 404, 'not_found', err.message);
    if (code === 'conflict') return apiError(c, 409, 'conflict', err.message);
    if (code === 'not_implemented') return apiError(c, 501, 'not_implemented', err.message);
    console.error('[server]', err);
    return apiError(c, 500, 'internal', err.message);
  });

  app.get('/api/health', (c) => {
    const body: HealthResponse = { ok: true, day: ctx.clock.today(), provider: ctx.models.provider(), agent: ctx.agentMode };
    return c.json(body);
  });

  for (const routes of [
    householdRoutes,
    threadRoutes,
    caseRoutes,
    demoRoutes,
    negotiationRoutes,
    voiceRoutes,
    eventRoutes,
    arenaRoutes,
    mediaRoutes,
  ]) {
    app.route('/api', routes(ctx));
  }

  app.notFound((c) => apiError(c, 404, 'not_found', `${c.req.method} ${c.req.path} not found`));
  return app;
}
