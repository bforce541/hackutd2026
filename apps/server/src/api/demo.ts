/**
 * Routes (SPEC §4). Implemented by: server-core.
 * Mounted at /api by app.ts. Endpoints this router owns:
 *   POST /demo/reset (store.reset(ctx.loadHousehold()), emit demo.reset, publish SSE 'reset', then
 *        publishForecast() from ../forecast.ts)
 *   POST /demo/clock (store.setDay, emit clock.changed, publish 'clock', publishForecast(), then
 *        watcher.onClockChange)
 *   POST /demo/bill-photo (fixture 'brake_quote': the bytes of apps/server/fixtures/brake_quote.png;
 *        or multipart field 'image'. Either way routeIncoming(ctx, { image, fixture?, channel:
 *        'imessage' }), exactly like a photo Yoshua texted)
 *   POST /demo/customer-says (routeIncoming(ctx, { text, channel: 'imessage' }))
 *   POST /demo/fail-call (addition: CALL_FAILED on the active call)
 * Validate bodies with the request schemas in @pacepay/shared (parseBody), return the
 * response types from @pacepay/shared/api, and errors with apiError().
 */
import { Hono } from 'hono';
import type { ServerContext } from '../context';

export function demoRoutes(_ctx: ServerContext): Hono {
  const r = new Hono();
  return r;
}
