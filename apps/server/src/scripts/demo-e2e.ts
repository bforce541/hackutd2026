/**
 * pnpm demo:e2e (SPEC §11): the scripted end-to-end run, no phones and no audio. Drives the server
 * through the demo endpoints and the lender console and asserts on the SSE stream.
 * Implemented by: demo-e2e.
 *
 * By default it boots its own server in this process, made safe for a script: console messaging
 * (nothing reaches Yoshua's phone), LENDER_PHONE and LiveKit unset (place_call fails without
 * dialing, so the negotiation moves to text), a throwaway data dir and quiet hours off.
 *
 *   pnpm demo:e2e                          real agent, provider picked by TRUEFOUNDRY_API_KEY
 *   pnpm demo:e2e -- --provider nvidia     real agent, NVIDIA mode (TRUEFOUNDRY_API_KEY dropped)
 *   pnpm demo:e2e -- --agent stub          the scripted agent, no model calls
 *   pnpm demo:e2e -- --server [url]        drive a running server instead (SERVER_URL by default);
 *                                          that server's own messaging and LENDER_PHONE apply
 *
 * Expected numbers come from @pacepay/engine on the fixture household (never computed here) and
 * are also checked against the v2.md rows they stand for.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as engine from '@pacepay/engine';
import {
  callingText,
  formatDate,
  limitsText,
  type ActivityEvent,
  type Approval,
  type CaseSnapshot,
  type Forecast,
  type Message,
  type Negotiation,
} from '@pacepay/shared';

// ---------------------------------------------------------------------------
// Arguments and server
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
};
const agentMode = (flag('agent') ?? 'real') === 'stub' ? 'stub' : 'real';
const provider = flag('provider');
const external = flag('server');
const STEP_MS = Number(flag('step-timeout') ?? 180_000);

let base = '';
let shutdown: () => void = () => {};

async function startServer(): Promise<void> {
  if (external !== undefined) {
    base = (external || process.env.SERVER_URL || 'http://localhost:8787').replace(/\/$/, '');
    console.log(`[e2e] driving the server at ${base}`);
    return;
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'pacepay-e2e-'));
  Object.assign(process.env, {
    PACEPAY_MESSAGING: 'console',
    PACEPAY_AGENT: agentMode,
    PACEPAY_DATA_DIR: dataDir,
    PACEPAY_IGNORE_QUIET_HOURS: '1',
  });
  for (const k of ['LENDER_PHONE', 'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_SIP_OUTBOUND_TRUNK_ID']) delete process.env[k];
  if (provider === 'nvidia') delete process.env.TRUEFOUNDRY_API_KEY;
  const [{ buildContext }, { createApp }, { serve }] = await Promise.all([import('../index'), import('../app'), import('@hono/node-server')]);
  const ctx = buildContext();
  const app = createApp(ctx);
  const port = Number(flag('port') ?? 8797);
  const server = serve({ fetch: app.fetch, port });
  base = `http://localhost:${port}`;
  shutdown = () => {
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  console.log(`[e2e] in-process server on ${base} (agent: ${ctx.agentMode}, models: ${ctx.models.provider()}, data: ${dataDir})`);
}

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---------------------------------------------------------------------------
// SSE: every event since the run started, plus waiters
// ---------------------------------------------------------------------------

interface Sse {
  seq: number;
  event: string;
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const events: Sse[] = [];
const waiters = new Set<() => void>();
let sseAbort: AbortController | null = null;

async function openSse(): Promise<void> {
  sseAbort = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { accept: 'text/event-stream' }, signal: sseAbort.signal });
  if (!res.ok || !res.body) throw new Error(`GET /api/events -> ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += value;
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          let id = '';
          let event = 'message';
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('id:')) id = line.slice(3).trim();
            else if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
          if (!data.length) continue;
          events.push({ seq: Number(id), event, data: JSON.parse(data.join('\n')) });
          for (const w of waiters) w();
        }
      }
    } catch {
      /* aborted at the end */
    }
  })();
}

/** Resolves with the first SSE event at or after `from` (index into events) that matches. */
function waitFor<T = any>(what: string, from: number, pick: (e: Sse) => T | undefined | false, ms = STEP_MS): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return new Promise((resolve, reject) => {
    let i = from;
    const check = () => {
      for (; i < events.length; i++) {
        const hit = pick(events[i]!);
        if (hit !== undefined && hit !== false) {
          cleanup();
          resolve(hit);
          return;
        }
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${ms / 1000}s waiting for ${what}`));
    }, ms);
    const cleanup = () => {
      clearTimeout(timer);
      waiters.delete(check);
    };
    waiters.add(check);
    check();
  });
}

const activities = (from = 0): ActivityEvent[] => events.slice(from).filter((e) => e.event === 'activity').map((e) => e.data as ActivityEvent);
const outTexts = (from = 0): Message[] => events.slice(from).filter((e) => e.event === 'thread' && e.data.direction === 'out' && e.data.text).map((e) => e.data as Message);
const pendingApproval = (kind: Approval['kind']) => (e: Sse) => e.event === 'approval' && e.data.kind === kind && e.data.status === 'pending' ? (e.data as Approval) : undefined;

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const results: { step: string; ok: boolean; note?: string }[] = [];
class StepFailed extends Error {}

function check(step: string, ok: boolean, note?: string): void {
  results.push({ step, ok, note });
  console.log(`${ok ? '  PASS' : '  FAIL'} ${step}${note ? ` (${note})` : ''}`);
}
function must(step: string, ok: boolean, note?: string): void {
  check(step, ok, note);
  if (!ok) throw new StepFailed(step);
}

/** Every integer in the engine outputs (cents), for the "every number is in the facts" check. */
function collectCents(value: unknown, into: Set<number>): Set<number> {
  if (typeof value === 'number' && Number.isInteger(value)) into.add(Math.abs(value));
  else if (Array.isArray(value)) value.forEach((v) => collectCents(v, into));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectCents(v, into));
  return into;
}

/** $ amounts in `text` that match no engine number ("about $550" may round, so within 2% or $1). */
function ungroundedMoney(text: string, facts: Set<number>): string[] {
  const found = text.match(/\$\s?[\d,]+(?:\.\d{1,2})?/g) ?? [];
  return found.filter((m) => {
    const cents = Math.round(Number(m.replace(/[$,\s]/g, '')) * 100);
    for (const f of facts) if (Math.abs(f - cents) <= Math.max(100, 0.02 * f)) return false;
    return true;
  });
}

const REASON_WORDS = /payday|paycheck|balance|floor|limit|overdra|afford|short|negative|below|because|since|tight|budget|\$/i;

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const h = engine.fixtures.household;
  const d0 = h.day0Date;
  const repair = { amount: 65_000, day: 0, label: 'Northside Auto Service' };
  const pay = engine.billChange(h, repair);
  const before = engine.forecast(h, { changes: [pay] }).lowest;
  const options = engine.buildOptions(h, repair);
  const targets = engine.planCallTargets(h, 'auto_payment', { baseChanges: [pay] });
  const deal = [pay, ...engine.offerChanges(h, { itemId: 'auto_payment', newDay: targets.targetDay, fee: 2_000 })];
  const after = engine.simulate(h, deal).forecast.lowest;
  const cd = engine.cdOptions(h, 'cd', { fromDay: 11 });
  // v2.md "Checking this week": no fix −$300 Tue (day 3); moved to Friday with a $20 fee, $100 (Mon, day 2).
  if (before.amount !== -30_000 || before.day !== 3 || after.amount !== 10_000 || after.day !== 2) throw new Error('engine fixture no longer matches the v2.md rows');

  // 1. Reset and inject the brake quote.
  console.log('\n[1] reset + brake_quote photo');
  await api('POST', '/demo/reset');
  const mark1 = events.length;
  await api('POST', '/demo/bill-photo', { fixture: 'brake_quote' });

  // 2. Plan, options text, lowest day.
  console.log('[2] plan + options text');
  let optionApproval: Approval | undefined;
  for (;;) {
    const a = await waitFor('the options text (option_choice approval)', mark1, (e) =>
      e.event === 'approval' && e.data.status === 'pending' && ['option_choice', 'bill_confirm'].includes(e.data.kind) ? (e.data as Approval) : undefined,
    );
    if (a.kind === 'option_choice') {
      optionApproval = a;
      break;
    }
    console.log('      (bill check asked; replying yes)');
    await api('POST', '/demo/customer-says', { text: 'yes' });
    await waitFor('the bill check resolved', mark1, (e) => e.event === 'approval' && e.data.id === a.id && e.data.status !== 'pending');
  }
  const plan = [...events].reverse().find((e) => e.event === 'case' && e.data.plan)?.data as CaseSnapshot | undefined;
  const wantAuthor = agentMode === 'stub' ? 'template' : 'nemotron-ultra';
  check('plan created', !!plan?.plan, plan?.plan ? `${plan.plan.steps.length} steps` : 'no plan on the case event');
  check(`plan author is ${wantAuthor}`, plan?.plan?.author === wantAuthor, `author ${plan?.plan?.author}`);
  check('plan.created activity emitted', activities(mark1).some((a) => a.type === 'plan.created'));
  const optionsText = optionApproval.prompt;
  console.log(optionsText.replace(/^/gm, '      | '));
  const facts = collectCents([options, before, targets, h.rules, h.accounts.map((a) => a.balance), repair.amount], new Set());
  const bad = ungroundedMoney(optionsText, facts);
  check('every $ in the options text comes from the engine', bad.length === 0, bad.length ? `not in facts: ${bad.join(', ')}` : undefined);
  check(`options text names the lowest day (${formatDate(before.day, d0)})`, optionsText.includes(formatDate(before.day, d0)));
  check('options text puts the move-payment call first', optionApproval.optionIds?.[0] === 'move_payment', `order ${optionApproval.optionIds?.join(', ')}`);
  const fc1 = await api<Forecast>('GET', '/forecast?days=14');
  check(`forecast lowest is -$300 on day ${before.day} (v2.md)`, fc1.lowest.amount === before.amount && fc1.lowest.day === before.day, `${fc1.lowest.amount} on day ${fc1.lowest.day}`);

  // 3. "1" -> limits text, no call yet.
  console.log('[3] customer says "1"');
  const mark3 = events.length;
  await api('POST', '/demo/customer-says', { text: '1' });
  const limits = await waitFor('the limits text (call_limits approval)', mark3, pendingApproval('call_limits'));
  const wantLimits = limitsText({ toDay: targets.targetDay, feeLimit: targets.feeLimit, day0Date: d0 });
  check('limits text matches UI.md', limits.prompt === wantLimits, limits.prompt);
  check('no call placed before "ok"', !activities(mark1).some((a) => a.tool === 'place_call' || a.type === 'call.dispatched'));

  // 4. "ok" -> second opinion before the call, then the negotiation opens in text mode.
  console.log('[4] customer says "ok"');
  const mark4 = events.length;
  await api('POST', '/demo/customer-says', { text: 'ok' });
  const neg0 = await waitFor('the negotiation in text mode', mark4, (e) => e.event === 'negotiation' && e.data.channel === 'text' ? (e.data as Negotiation) : undefined);
  const acts4 = activities(mark4);
  const review = acts4.find(
    (a) => a.type === 'review.result' || (a.tool === 'second_opinion' && a.type === 'tool.result') || (a.type === 'step.skipped' && /second opinion/i.test(a.title)),
  );
  const placed = acts4.find((a) => a.tool === 'place_call' || a.type === 'call.dispatched');
  check('second_opinion ran (or was skipped with a warn) before the call', !!review && (!placed || review.seq < placed.seq), review ? `${review.type}: ${review.title}${review.level === 'warn' ? ' [warn]' : ''}` : 'no second-opinion activity');
  check('"Calling your lender now." went out', outTexts(mark4).some((m) => m.text === callingText()));
  check('negotiation opened in text mode', neg0.channel === 'text');
  const negId = neg0.id;
  const opened = await api<Negotiation>('GET', `/negotiations/${negId}`);
  const opening = (opened.transcript ?? []).find((l) => l.speaker === 'pacepay')?.text ?? '';
  console.log(`      PacePay: ${opening}`);
  check('opening line discloses the AI and the transcript', /AI/.test(opening) && /transcri/i.test(opening));

  const lender = async (text: string) => {
    const r = await api<{ reply: string; state: Negotiation['state']; awaitingApproval: boolean }>('POST', `/negotiations/${negId}/lender`, { text });
    console.log(`      Lender: ${text}\n      PacePay: ${r.reply}`);
    return r;
  };

  // 5. Wednesday: read-back, then the check fails and the counter has no $ and no reason.
  console.log('[5] lender offers Wednesday');
  const wed = await lender('We can do Wednesday.');
  check('Wednesday is read back first', /wed/i.test(wed.reply) && /\?/.test(wed.reply));
  const mark5 = events.length;
  const wedYes = await lender('Yes.');
  const n5 = await api<Negotiation>('GET', `/negotiations/${negId}`);
  const wedOffer = n5.offers.find((o) => o.newDay === 4);
  const wedCheck = (n5.checks ?? []).find((c) => c.offerId === wedOffer?.id);
  check('offer.checked fails for Wednesday', !!wedCheck && !wedCheck.pass && activities(mark5).some((a) => a.type === 'offer.checked'), wedCheck ? `reasons ${wedCheck.reasons.join(', ')}` : 'no check stored');
  check('counter has no $ amount and no reason', !REASON_WORDS.test(wedYes.reply), wedYes.reply);

  // 6. Friday with a $20 fee -> read-back -> deal approval with a 60 s timeout.
  console.log('[6] lender offers Friday, $20');
  const fri = await lender('Friday, with a twenty dollar fee.');
  check('Friday $20 is read back first', /fri/i.test(fri.reply) && /\$20|twenty/i.test(fri.reply) && /\?/.test(fri.reply));
  const mark6 = events.length;
  const friYes = await lender('Yes.');
  const dealApproval = await waitFor('the deal approval', mark6, pendingApproval('deal'), 30_000);
  check('deal approval requested with a 60 s timeout', friYes.awaitingApproval && dealApproval.timeoutMs === 60_000, `timeoutMs ${dealApproval.timeoutMs}`);
  console.log(dealApproval.prompt.replace(/^/gm, '      | '));

  // 7. "yes" -> deal confirmed, summary text, forecast lowest = the "moved to Friday" row.
  console.log('[7] customer says "yes"');
  const mark7 = events.length;
  await api('POST', '/demo/customer-says', { text: 'yes' });
  // The negotiator thanks the lender and asks for a reference number (the stub closes right away).
  const asked = await waitForNegotiation(negId, (n) => n.state === 'closed' || /reference/i.test(lastPacepay(n)));
  if (asked.state !== 'closed') await lender('Sure, your reference number is A1B2C3.');
  const done = await waitFor('the case to reach DONE', mark7, (e) => e.event === 'case' && e.data.case.state === 'DONE' ? (e.data as CaseSnapshot) : undefined);
  const n7 = await api<Negotiation>('GET', `/negotiations/${negId}`);
  check('deal confirmed', n7.outcome === 'deal', `outcome ${n7.outcome}, ref ${n7.referenceNumber ?? 'none'}`);
  const summary = outTexts(mark7).find((m) => /^Done\./.test(m.text ?? ''));
  check('summary text went out', !!summary, summary?.text ?? outTexts(mark7).map((m) => m.text).join(' | '));
  const fc7 = await api<Forecast>('GET', '/forecast?days=14');
  check('forecast lowest matches v2.md "moved to Friday" ($100, Mon)', fc7.lowest.amount === after.amount && fc7.lowest.day === after.day, `${fc7.lowest.amount} on day ${fc7.lowest.day}`);
  check('case is DONE', done.case.state === 'DONE');

  // 8. Clock to day 11 -> the CD alert, unprompted, numbers from cdOptions.
  console.log('[8] clock to day 11');
  const mark8 = events.length;
  await api('POST', '/demo/clock', { day: 11 });
  const alert = await waitFor('the CD alert text', mark8, (e) => e.event === 'thread' && e.data.direction === 'out' && /\bCD\b/.test(e.data.text ?? '') ? (e.data as Message) : undefined);
  console.log((alert.text ?? '').replace(/^/gm, '      | '));
  const inbound = events.slice(mark8).some((e) => e.event === 'thread' && e.data.direction === 'in');
  check('CD alert went out with no prompt from Yoshua', !inbound);
  const cdFacts = collectCents([cd, h.accounts.map((a) => a.balance)], new Set());
  const cdBad = ungroundedMoney(alert.text ?? '', cdFacts);
  check('CD alert numbers come from cdOptions', cdBad.length === 0 && /2,214/.test(alert.text ?? '') && /2,786/.test(alert.text ?? ''), cdBad.length ? `not in facts: ${cdBad.join(', ')}` : undefined);
}

function lastPacepay(n: Negotiation): string {
  return [...(n.transcript ?? [])].reverse().find((l) => l.speaker === 'pacepay')?.text ?? '';
}

async function waitForNegotiation(id: string, ok: (n: Negotiation) => boolean, ms = 60_000): Promise<Negotiation> {
  const end = Date.now() + ms;
  for (;;) {
    // GET also settles a resolved deal approval (approvalOutcome), like the lender console does.
    const n = await api<Negotiation>('GET', `/negotiations/${id}`);
    if (ok(n) && n.state !== 'awaiting_approval') return n;
    if (Date.now() > end) throw new Error(`timed out waiting on negotiation ${id} (state ${n.state})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function describe(e: Sse): string {
  const d = e.data;
  if (e.event === 'activity') return `${d.type}${d.level && d.level !== 'info' ? ` [${d.level}]` : ''} ${d.title}`;
  if (e.event === 'approval') return `${d.kind} ${d.status}`;
  if (e.event === 'case') return `${d.case.state}`;
  if (e.event === 'negotiation') return `${d.channel} ${d.state}`;
  if (e.event === 'thread') return `${d.direction} ${(d.text ?? d.imageUrl ?? '').slice(0, 80)}`;
  return JSON.stringify(d).slice(0, 80);
}

async function main(): Promise<void> {
  const started = Date.now();
  await startServer();
  await openSse();
  let crashed: Error | undefined;
  try {
    await run();
  } catch (err) {
    crashed = err as Error;
    if (!(err instanceof StepFailed)) {
      results.push({ step: 'run', ok: false, note: crashed.message });
      console.log(`  FAIL ${crashed.message}`);
    }
    console.log(`\n[e2e] last SSE events:\n${events.slice(-25).map((e) => `  ${e.seq} ${e.event}: ${describe(e)}`).join('\n')}`);
  }
  sseAbort?.abort();
  const failed = results.filter((r) => !r.ok);
  const errors = activities().filter((a) => a.level === 'error');
  if (errors.length) console.log(`\n[e2e] ${errors.length} error-level activity events:\n${errors.map((a) => `  - ${a.type}: ${a.title}`).join('\n')}`);
  console.log(`\n[e2e] ${results.length - failed.length}/${results.length} checks passed in ${Math.round((Date.now() - started) / 1000)}s (agent: ${agentMode}${provider ? `, provider: ${provider}` : ''})`);
  shutdown();
  process.exit(failed.length || crashed ? 1 : 0);
}

void main();
