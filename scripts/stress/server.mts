/**
 * Stress child server: one throwaway PacePay server per persona (never the live :8787).
 *
 * - Own port (STRESS_PORT) and own data dir (PACEPAY_DATA_DIR); console messaging; quiet hours off.
 * - Never dials anyone: LiveKit and Photon env are deleted and ctx.dispatch is replaced with a fake
 *   that only records the dial. LENDER_PHONE is set to a fictional 555 number ONLY inside this
 *   process so place_call creates the Call row (with it unset, place_call fails over to text mode
 *   and the voice path is never exercised). The fake dispatcher is the only thing that sees it.
 * - STRESS_RESTORE=<dir>: copy that snapshot (state.json + media) into the data dir before boot, so
 *   the case starts already at the calling step.
 * - Extra routes for the harness only: GET /__stress/state (the whole store), POST /__stress/snapshot
 *   (flush state.json now), GET /__stress/dials, GET /__stress/idle (agent queue idle?).
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/Users/ramsarma/hackutd26';
const port = Number(process.env.STRESS_PORT ?? 8990);
const dataDir = process.env.PACEPAY_DATA_DIR;
if (!dataDir || /hackutd26\/data\/?$/.test(dataDir)) throw new Error('stress server needs its own PACEPAY_DATA_DIR');
mkdirSync(dataDir, { recursive: true });
if (process.env.STRESS_RESTORE) {
  const src = process.env.STRESS_RESTORE;
  if (existsSync(join(src, 'state.json'))) cpSync(src, dataDir, { recursive: true });
}
Object.assign(process.env, {
  PACEPAY_MESSAGING: 'console',
  PACEPAY_AGENT: process.env.STRESS_AGENT ?? 'real',
  PACEPAY_IGNORE_QUIET_HOURS: '1',
  LENDER_PHONE: '+15555550123',
});
for (const k of [
  'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_SIP_OUTBOUND_TRUNK_ID', 'LIVEKIT_SIP_INBOUND_TRUNK_ID',
  'LIVEKIT_SIP_DISPATCH_RULE_ID', 'PHOTON_API_KEY', 'PHOTON_PROJECT_ID', 'CUSTOMER_PHONE', 'DATABASE_URL',
]) delete process.env[k];

const SRV = `${REPO}/apps/server/src`;
const { buildContext } = await import(`${SRV}/index.ts`);
const { createApp } = await import(`${SRV}/app.ts`);
const { serve } = await import(`${REPO}/apps/server/node_modules/@hono/node-server/dist/index.mjs`);
const { Hono } = await import(`${REPO}/apps/server/node_modules/hono/dist/index.js`);

const ctx = buildContext();
if (!process.env.STRESS_RESTORE) ctx.store.reset(ctx.loadHousehold());
const dials: unknown[] = [];
ctx.dispatch = {
  async placeCall(args: unknown) {
    dials.push({ at: new Date().toISOString(), ...(args as object) });
  },
  async hangUp(room: string) {
    dials.push({ at: new Date().toISOString(), hangUp: room });
  },
};

// Track the agent queue: wrap enqueue so the harness can wait for "idle".
let inflight = 0;
let lastEventAt = Date.now();
const origEnqueue = ctx.enqueue.bind(ctx);
const origHandle = ctx.agent.handle.bind(ctx.agent);
ctx.agent.handle = async (ev: unknown) => {
  inflight += 1;
  lastEventAt = Date.now();
  try {
    return await origHandle(ev);
  } finally {
    inflight -= 1;
    lastEventAt = Date.now();
  }
};
ctx.enqueue = (ev: unknown) => {
  lastEventAt = Date.now();
  origEnqueue(ev);
};

const app = new Hono();
app.get('/__stress/state', (c: any) => c.json({ ...ctx.store.get(), __dials: dials, __inflight: inflight }));
app.get('/__stress/idle', (c: any) => c.json({ inflight, quietMs: Date.now() - lastEventAt }));
app.post('/__stress/snapshot', (c: any) => {
  ctx.store.snapshot();
  return c.json({ ok: true, dataDir });
});
app.route('/', createApp(ctx));
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  console.log(`[stress-server] ready on ${port} agent=${ctx.agentMode} models=${ctx.models.provider()} data=${dataDir}`);
});
process.on('SIGTERM', () => {
  try {
    ctx.store.snapshot();
  } catch {
    /* ignore */
  }
  process.exit(0);
});
