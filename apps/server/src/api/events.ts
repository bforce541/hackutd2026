/**
 * Routes (SPEC §4). Implemented by: server-core.
 * Mounted at /api by app.ts. Endpoints this router owns:
 *   GET  /events (text/event-stream; 'id: <seq>' and 'event: <name>' on every message; resume from the
 *        Last-Event-ID header or the ?lastEventId= query (the dashboard's first connect) with bus.since();
 *        a keep-alive comment every 15 s)
 * Validate bodies with the request schemas in @pacepay/shared (parseBody), return the
 * response types from @pacepay/shared/api, and errors with apiError().
 */
import { Hono } from 'hono';
import type { ServerContext } from '../context';

export function eventRoutes(_ctx: ServerContext): Hono {
  const r = new Hono();
  return r;
}
