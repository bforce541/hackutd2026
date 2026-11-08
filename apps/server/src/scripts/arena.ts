/**
 * pnpm arena -- --count 50 --concurrency 4 (SPEC §11). Implemented by: arena.
 * Runs agent/arena.ts in-process (or POSTs /api/arena/run when --server is given) and writes data/arena.json.
 *
 * In-process runs use a scratch data dir for the context's own store, so they never overwrite a
 * running server's data/state.json. Run it through dotenvx from the repo root for model keys.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SERVER_URL } from '@pacepay/shared';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : '';
}

const count = Number(arg('count') ?? 50);
const concurrency = Number(arg('concurrency') ?? 4);
const server = arg('server');
if (!Number.isInteger(count) || count < 1 || !Number.isInteger(concurrency) || concurrency < 1) {
  console.error('usage: pnpm arena -- --count 50 --concurrency 4 [--server [url]]');
  process.exit(2);
}

async function viaServer(base: string): Promise<void> {
  const res = await fetch(`${base}/api/arena/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count, concurrency }),
  });
  if (!res.ok) throw new Error(`POST /api/arena/run -> ${res.status} ${await res.text()}`);
  const { runId } = (await res.json()) as { runId: string };
  console.log(`[arena] started ${runId} on ${base}; progress is on the SSE stream, results at GET /api/arena`);
}

async function inProcess(): Promise<void> {
  process.env.PACEPAY_DATA_DIR = mkdtempSync(join(tmpdir(), 'pacepay-arena-ctx-'));
  process.env.PACEPAY_MESSAGING = 'console';
  const { buildContext } = await import('../index');
  const { startArenaRun, ARENA_FILE } = await import('../agent/arena');
  const ctx = buildContext();
  const { runId, done } = startArenaRun(ctx, { count, concurrency });
  console.log(`[arena] ${runId}: ${count} runs, concurrency ${concurrency}`);
  let last = -1;
  const unsub = ctx.bus.subscribe((e) => {
    if (e.event === 'arena' && e.data.done !== last) {
      last = e.data.done;
      const l = e.data.latest;
      const g = l && typeof l.grade === 'object' ? l.grade : null;
      console.log(`[arena] ${e.data.done}/${e.data.total}${l ? `  ${l.persona}: ${l.outcome ?? '-'}${g ? `, deal=${g.deal_reached} violation=${g.limit_violation} disclosure=${g.disclosure}` : `, ${String(l.grade)}`}` : ''}`);
    }
  });
  const r = await done;
  unsub();
  const errored = r.runs.filter((x) => x.grade === 'errored').length;
  console.log(`[arena] done: ${r.total} counted (${errored} errored), deal rate ${(r.dealRate * 100).toFixed(0)}%, limit violations ${r.limitViolations}, disclosures ${r.disclosures}, read-back ${(r.readBackRate * 100).toFixed(0)}%`);
  console.log(`[arena] wrote ${ARENA_FILE}`);
}

(server !== undefined ? viaServer(server || DEFAULT_SERVER_URL) : inProcess())
  .then(() => process.exit(0))
  .catch((err: Error) => {
    console.error(`[arena] failed: ${err.message}`);
    process.exit(1);
  });
