/**
 * Routes (SPEC §4). Implemented by: server-core.
 * Mounted at /api by app.ts. Endpoints this router owns:
 *   GET  /thread
 *   POST /thread (coach chat; messaging/router.ts routeIncoming(ctx, { text, channel: 'dashboard' }), which records and enqueues)
 * Validate bodies with the request schemas in @pacepay/shared (parseBody), return the
 * response types from @pacepay/shared/api, and errors with apiError().
 */
import { Hono } from 'hono';
import { PostThreadRequestSchema } from '@pacepay/shared';
import type { PostThreadResponse, ThreadResponse } from '@pacepay/shared';
import type { ServerContext } from '../context';
import { routeIncoming } from '../messaging/router';
import { parseBody } from './http';

export function threadRoutes(ctx: ServerContext): Hono {
  const r = new Hono();

  r.get('/thread', (c) => {
    const body: ThreadResponse = ctx.store.thread();
    return c.json(body);
  });

  r.post('/thread', async (c) => {
    const { text } = await parseBody(c, PostThreadRequestSchema);
    await routeIncoming(ctx, { text, channel: 'dashboard' });
    const body: PostThreadResponse = { ok: true };
    return c.json(body);
  });

  return r;
}
