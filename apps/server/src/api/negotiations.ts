/**
 * Routes (SPEC §4). Implemented by: negotiator.
 * Mounted at /api by app.ts. Endpoints this router owns:
 *   POST /negotiations/:id/lender (the lender console; calls agent/negotiator.ts decide)
 *   GET  /negotiations/:id
 * Validate bodies with the request schemas in @pacepay/shared (parseBody), return the
 * response types from @pacepay/shared/api, and errors with apiError().
 */
import { Hono } from 'hono';
import type { ServerContext } from '../context';

export function negotiationRoutes(_ctx: ServerContext): Hono {
  const r = new Hono();
  return r;
}
