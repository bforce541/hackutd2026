/**
 * Routes (SPEC §4). Implemented by: server-core.
 * Mounted at /api by app.ts. Endpoints this router owns:
 *   GET  /household
 *   GET  /forecast?days=60
 *   GET  /scores
 *   POST /simulate
 *   GET  /rules
 *   PUT  /rules (publish SSE 'rules')
 * Validate bodies with the request schemas in @pacepay/shared (parseBody), return the
 * response types from @pacepay/shared/api, and errors with apiError().
 */
import { Hono } from 'hono';
import type { ServerContext } from '../context';

export function householdRoutes(_ctx: ServerContext): Hono {
  const r = new Hono();
  return r;
}
