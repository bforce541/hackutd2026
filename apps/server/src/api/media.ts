/**
 * Routes (SPEC §4). Implemented by: server-core.
 * Mounted at /api by app.ts. Endpoints this router owns:
 *   GET  /media/:id (bytes from store.getMedia with its content type)
 * Validate bodies with the request schemas in @pacepay/shared (parseBody), return the
 * response types from @pacepay/shared/api, and errors with apiError().
 */
import { Hono } from 'hono';
import type { ServerContext } from '../context';
import { apiError } from './http';

export function mediaRoutes(ctx: ServerContext): Hono {
  const r = new Hono();

  r.get('/media/:id', (c) => {
    const found = ctx.store.getMedia(c.req.param('id'));
    if (!found) return apiError(c, 404, 'not_found', `media ${c.req.param('id')} not found`);
    return new Response(new Uint8Array(found.data), {
      headers: { 'Content-Type': found.meta.contentType, 'Cache-Control': 'private, max-age=3600' },
    });
  });

  return r;
}
