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

  // Requests that arrive through the public tunnel (Tailscale Funnel or any reverse proxy) are
  // view-only: anyone on pacepay.work can watch the live demo, but only this laptop can act on it.
  // The voice worker's endpoints are local-only, so they're closed to the tunnel entirely.
  app.use('/api/*', async (c, next) => {
    if (isProxied(c.req.raw.headers)) {
      if (c.req.path.startsWith('/api/voice/')) return apiError(c, 403, 'read_only', 'Not available through the public tunnel');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
        return apiError(c, 403, 'read_only', 'The public dashboard is view-only');
      }
    }
    await next();
  });

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
    const body: HealthResponse = {
      ok: true,
      day: ctx.clock.today(),
      provider: ctx.models.provider(),
      agent: ctx.agentMode,
      ...(isProxied(c.req.raw.headers) ? { readOnly: true } : {}),
    };
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

/** True when a request came through a tunnel or proxy rather than straight from this machine. */
export function isProxied(headers: Headers): boolean {
  return headers.has('tailscale-funnel-request') || headers.has('x-forwarded-for') || headers.has('forwarded');
}
