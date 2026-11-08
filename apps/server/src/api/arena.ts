/**
 * Routes (SPEC §4). Implemented by: arena.
 * Mounted at /api by app.ts. Endpoints this router owns:
 *   GET  /arena (store.arena() or the sample results)
 *   POST /arena/run (agent/arena.ts startArenaRun)
 * Validate bodies with the request schemas in @pacepay/shared (parseBody), return the
 * response types from @pacepay/shared/api, and errors with apiError().
 */
import { Hono } from 'hono';
import type { ServerContext } from '../context';

export function arenaRoutes(_ctx: ServerContext): Hono {
  const r = new Hono();
  return r;
}
