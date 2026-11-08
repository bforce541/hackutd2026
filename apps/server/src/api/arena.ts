/**
 * Routes (SPEC §4). Implemented by: arena.
 * Mounted at /api by app.ts. Endpoints this router owns:
 *   GET  /arena (store.arena() or the sample results: the full 50-run arena)
 *   GET  /arena/live (the latest "Run 3 live", kept apart from the full results)
 *   POST /arena/run (agent/arena.ts startArenaRun; live: true runs 3; progress over SSE `arena`)
 *
 * A live request while a live run is going answers with that run's id (no error); live and full
 * runs never block each other, and a live run never touches data/arena.json or store.arena.
 */
import { Hono } from 'hono';
import { ArenaRunRequestSchema, type ArenaResponse, type ArenaRunResponse } from '@pacepay/shared';
import { getLiveArena, startArenaRun } from '../agent/arena';
import type { ServerContext } from '../context';
import { apiError, parseBody } from './http';

/** What GET /arena returns before any run: no tiles, flagged as sample so the dashboard shows its own. */
const SAMPLE: ArenaResponse = { runId: 'sample', total: 0, dealRate: 0, limitViolations: 0, disclosures: 0, readBackRate: 0, runs: [], sample: true };

export function arenaRoutes(ctx: ServerContext): Hono {
  const r = new Hono();
  const running: { full: string | null; live: string | null } = { full: null, live: null };

  r.get('/arena', (c) => c.json((ctx.store.arena() ?? SAMPLE) satisfies ArenaResponse));

  r.get('/arena/live', (c) => c.json(getLiveArena() ?? { runId: null, total: 3, done: 0, finished: true, runs: [], sources: [] }));

  r.post('/arena/run', async (c) => {
    const body = await parseBody(c, ArenaRunRequestSchema);
    const kind = body.live ? 'live' : 'full';
    const busy = running[kind];
    if (busy) {
      if (kind === 'live') return c.json({ runId: busy } satisfies ArenaRunResponse, 202);
      return apiError(c, 409, 'conflict', `Arena run ${busy} is still going`);
    }
    const { runId, done } = startArenaRun(ctx, body);
    running[kind] = runId;
    const release = () => {
      if (running[kind] === runId) running[kind] = null;
    };
    done.then(release, (err: Error) => {
      release();
      ctx.bus.emit({ type: 'step.failed', model: 'code', level: 'error', title: `Arena run failed: ${err.message}` });
    });
    return c.json({ runId } satisfies ArenaRunResponse, 202);
  });

  return r;
}
