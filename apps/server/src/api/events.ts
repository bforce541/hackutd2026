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
import { streamSSE } from 'hono/streaming';
import type { SseEvent } from '@pacepay/shared';
import type { ServerContext } from '../context';

export function eventRoutes(ctx: ServerContext): Hono {
  const r = new Hono();

  r.get('/events', (c) => {
    const header = c.req.header('Last-Event-ID') ?? c.req.query('lastEventId');
    const parsed = header === undefined || header === '' ? NaN : Number(header);
    const resumeFrom = Number.isFinite(parsed) ? parsed : null;

    c.header('X-Accel-Buffering', 'no');
    c.header('Cache-Control', 'no-cache, no-transform');
    return streamSSE(c, async (stream) => {
      const queue: SseEvent[] = [];
      let wake: (() => void) | null = null;
      let sent = resumeFrom ?? ctx.bus.lastSeq();

      // Subscribe before replaying so nothing published during the replay is lost.
      const unsubscribe = ctx.bus.subscribe((e) => {
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });

      const write = (e: SseEvent) => stream.writeSSE({ id: String(e.seq), event: e.event, data: JSON.stringify(e.data) });

      await stream.write(': connected\n\n');
      if (resumeFrom !== null) {
        for (const e of ctx.bus.since(resumeFrom)) {
          await write(e);
          sent = e.seq;
        }
      }

      try {
        while (!stream.aborted && !stream.closed) {
          while (queue.length) {
            const e = queue.shift()!;
            if (e.seq <= sent) continue;
            await write(e);
            sent = e.seq;
          }
          let timedOut = false;
          await new Promise<void>((resolve) => {
            const t = setTimeout(() => {
              timedOut = true;
              resolve();
            }, 15_000);
            wake = () => {
              clearTimeout(t);
              resolve();
            };
          });
          wake = null;
          if (timedOut && !stream.aborted && !stream.closed) await stream.write(': keep-alive\n\n');
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return r;
}
