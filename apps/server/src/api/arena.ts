/**
 * Routes (SPEC §4). Implemented by: arena.
 * Mounted at /api by app.ts. Endpoints this router owns:
 *   GET  /arena (store.arena() or the sample results)
 *   POST /arena/run (agent/arena.ts startArenaRun; live: true runs 3; progress over SSE `arena`)
 */
import { Hono } from 'hono';
import { ArenaRunRequestSchema, type ArenaResponse, type ArenaRunResponse } from '@pacepay/shared';
import { startArenaRun } from '../agent/arena';
import type { ServerContext } from '../context';
import { apiError, parseBody } from './http';

/** What GET /arena returns before any run: no tiles, flagged as sample so the dashboard shows its own. */
const SAMPLE: ArenaResponse = { runId: 'sample', total: 0, dealRate: 0, limitViolations: 0, disclosures: 0, readBackRate: 0, runs: [], sample: true };

export function arenaRoutes(ctx: ServerContext): Hono {
  const r = new Hono();
  let running: string | null = null;

  r.get('/arena', (c) => c.json((ctx.store.arena() ?? SAMPLE) satisfies ArenaResponse));

  r.post('/arena/run', async (c) => {
    const body = await parseBody(c, ArenaRunRequestSchema);
    if (running) return apiError(c, 409, 'conflict', `Arena run ${running} is still going`);
    const { runId, done } = startArenaRun(ctx, body);
    running = runId;
    const release = () => {
      if (running === runId) running = null;
    };
    done.then(release, (err: Error) => {
      release();
      ctx.bus.emit({ type: 'step.failed', model: 'code', level: 'error', title: `Arena run failed: ${err.message}` });
    });
    return c.json({ runId } satisfies ArenaRunResponse, 202);
  });

  return r;
}
