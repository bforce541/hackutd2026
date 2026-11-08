/**
 * Routes (SPEC §4). Implemented by: server-core.
 * Mounted at /api by app.ts. Endpoints this router owns:
 *   GET  /cases/current (CurrentCaseResponse, with the case's Bill or null)
 *   GET  /calls/:id
 *   POST /approvals/:id (addition: a dashboard button. routeIncoming(ctx, { text: answer, channel:
 *        'dashboard', approvalId }) so it is handled exactly as if Yoshua texted it; 409 when the
 *        approval is not pending)
 *   GET  /snapshot (addition: SnapshotResponse; forecast/scores/netWorth from ../forecast.ts,
 *        acceptedChanges = store.forecastChanges(), lastSeq = bus.lastSeq(). If the engine throws
 *        (not implemented yet), still answer: an empty forecast and [] scores)
 * Validate bodies with the request schemas in @pacepay/shared (parseBody), return the
 * response types from @pacepay/shared/api, and errors with apiError().
 */
import { Hono } from 'hono';
import type { ServerContext } from '../context';

export function caseRoutes(_ctx: ServerContext): Hono {
  const r = new Hono();
  return r;
}
