/**
 * Routes (SPEC §4). Implemented by: server-core.
 * Mounted at /api by app.ts. Endpoints this router owns:
 *   GET  /thread
 *   POST /thread (coach chat; messaging/router.ts routeIncoming(ctx, { text, channel: 'dashboard' }), which records and enqueues)
 * Validate bodies with the request schemas in @pacepay/shared (parseBody), return the
 * response types from @pacepay/shared/api, and errors with apiError().
 */
import { Hono } from 'hono';
import type { ServerContext } from '../context';

export function threadRoutes(_ctx: ServerContext): Hono {
  const r = new Hono();
  return r;
}
