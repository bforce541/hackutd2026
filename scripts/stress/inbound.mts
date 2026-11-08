/**
 * Inbound-call stress test (Yoshua dials PacePay, says the PIN, asks questions). TEST ONLY: never dials,
 * never texts, never touches the live server (:8787), the live worker ("pacepay-voice") or :3000.
 *
 *   api   : a throwaway in-process server (own port + PACEPAY_DATA_DIR, console messaging, LENDER_PHONE
 *           unset so the lender call runs over the lender console). Drives the real InboundConductor
 *           (apps/voice/src/conductor.ts) with a fake audio port against the real HTTP routes
 *           (/voice/inbound, verify-pin, ask): every spoken-PIN variant, three wrong PINs, a wrong caller
 *           ID, the question battery BEFORE any lender call and AFTER a completed deal.
 *   voice : the same throwaway server plus ONE test worker (pacepay-voice-test-<port>), and 10 inbound
 *           calls in a row over real LiveKit rooms; the caller speaks TTS audio (some with background
 *           noise). Measures time-to-greeting, per-turn latency, dead air, and hang-up vs the goodbye.
 *   lk    : read-only listing of the LiveKit SIP inbound trunks and dispatch rules.
 *
 * Run from the repo root:
 *   npx @dotenvx/dotenvx run --convention=nextjs -q -- apps/server/node_modules/.bin/tsx \
 *     scripts/stress/inbound.mts <api|voice|lk> [port]
 * Output: a log on stdout and a JSON summary in scripts/stress/out/inbound-<mode>-<ts>.json.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRV = join(ROOT, 'apps/server/src');
const VOICE = join(ROOT, 'apps/voice');
const OUT = join(ROOT, 'scripts/stress/out');
const mode = process.argv[2] ?? 'api';
const port = Number(process.argv[3] ?? (mode === 'voice' ? 8963 : 8961));
if (port === 8787 || port === 3000) throw new Error('never the live ports');
const TEST_AGENT = `pacepay-voice-test-${port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const ts = () => `${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s`;
const log = (s: string) => console.log(`${ts()} ${s}`);
const report: Record<string, unknown> = { mode, port, startedAt: new Date().toISOString() };
const e = process.env;
const PIN = e.INBOUND_PIN ?? '';
const CUSTOMER = e.CUSTOMER_PHONE ?? '';
const STRANGER = '+12145550142';

// ---------------------------------------------------------------------------------------------
// lk: read-only look at the inbound trunk and dispatch rule
// ---------------------------------------------------------------------------------------------
const pkg = (name: string) => pathToFileURL(join(realpathSync(join(VOICE, 'node_modules', name)), 'dist/index.js')).href;
async function lkCheck(): Promise<void> {
  const lk: any = await import(pkg('livekit-server-sdk'));
  const sip = new lk.SipClient(e.LIVEKIT_URL!.replace(/^wss:/, 'https:'), e.LIVEKIT_API_KEY, e.LIVEKIT_API_SECRET);
  const trunks: any[] = await sip.listSipInboundTrunk();
  const rules: any[] = await sip.listSipDispatchRule();
  const t = trunks.map((x) => ({ id: x.sipTrunkId, name: x.name, numbers: x.numbers, allowedNumbers: x.allowedNumbers, krisp: x.krispEnabled, configuredId: x.sipTrunkId === e.LIVEKIT_SIP_INBOUND_TRUNK_ID }));
  const r = rules.map((x) => ({
    id: x.sipDispatchRuleId,
    name: x.name,
    trunkIds: x.trunkIds,
    rule: x.rule?.rule?.case,
    roomPrefix: x.rule?.rule?.value?.roomPrefix,
    agents: (x.roomConfig?.agents ?? []).map((a: any) => a.agentName),
    configuredId: x.sipDispatchRuleId === e.LIVEKIT_SIP_DISPATCH_RULE_ID,
  }));
  console.log(JSON.stringify({ inboundTrunks: t, dispatchRules: r }, null, 2));
  report.lk = { inboundTrunks: t, dispatchRules: r };
}
if (mode === 'lk') {
  await lkCheck();
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Throwaway server (never the live one)
// ---------------------------------------------------------------------------------------------
const dataDir = mkdtempSync(join(tmpdir(), `pacepay-inbound-${mode}-`));
Object.assign(process.env, { PACEPAY_MESSAGING: 'console', PACEPAY_AGENT: 'real', PACEPAY_DATA_DIR: dataDir, PACEPAY_IGNORE_QUIET_HOURS: '1' });
// LENDER_PHONE unset: the lender call fails over to the text negotiation (the lender console).
for (const k of ['LENDER_PHONE', 'PHOTON_API_KEY', 'PHOTON_PROJECT_ID', 'LIVEKIT_SIP_OUTBOUND_TRUNK_ID', 'DATABASE_URL']) delete process.env[k];
if (mode !== 'voice') for (const k of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) delete process.env[k];
const { buildContext } = await import(pathToFileURL(join(SRV, 'index.ts')).href);
const { createApp } = await import(pathToFileURL(join(SRV, 'app.ts')).href);
const { buildFacts } = await import(pathToFileURL(join(SRV, 'agent/qa.ts')).href);
const { serve } = await import(pathToFileURL(join(ROOT, 'apps/server/node_modules/@hono/node-server/dist/index.mjs')).href);
const conductorMod: any = await import(pathToFileURL(join(VOICE, 'src/conductor.ts')).href);
const serverClientMod: any = await import(pathToFileURL(join(VOICE, 'src/server.ts')).href);
const ctx = buildContext();
ctx.store.reset(ctx.loadHousehold());
const hangUps: { at: number; room: string }[] = [];
let lkRooms: any;
ctx.dispatch = {
  async placeCall() {
    throw new Error('inbound test: no outbound calls');
  },
  async hangUp(room: string) {
    hangUps.push({ at: Date.now(), room });
    if (lkRooms) await lkRooms.deleteRoom(room).catch(() => undefined);
  },
};
// Every bus event that mentions an inbound call (for the dashboard's "Yoshua called in" line).
const inboundIds = new Set<string>();
const busEvents: any[] = [];
ctx.bus.subscribe((ev: any) => {
  const d = ev.data ?? {};
  const callId = d.detail?.callId ?? (ev.event === 'call' ? d.id : undefined);
  const isInbound = (ev.event === 'call' && d.direction === 'inbound') || (callId && inboundIds.has(callId)) || (ev.event === 'activity' && /inbound/i.test(d.title ?? ''));
  if (isInbound) busEvents.push({ sse: ev.event, at: Date.now(), ...(ev.event === 'activity' ? { type: d.type, level: d.level, model: d.model, title: d.title, caseId: d.caseId, detail: d.detail } : { callStatus: d.status, pinVerified: d.pinVerified, transcriptLen: d.transcript?.length, keys: Object.keys(d) }) });
});
const server = serve({ fetch: createApp(ctx).fetch, port, hostname: '127.0.0.1' });
const base = `http://127.0.0.1:${port}`;
async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${base}/api${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${t}`);
  return t ? JSON.parse(t) : undefined;
}
async function until(what: string, ok: () => Promise<boolean> | boolean, ms = 240_000, step = 300): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(step);
  }
}
log(`[inbound] mode=${mode} server=${base} data=${dataDir} models=${ctx.models.provider()} pinSet=${PIN.length === 4} customerSet=${!!CUSTOMER}`);

// ---------------------------------------------------------------------------------------------
// Driving the text demo to a deal (lender console), same as the scratch harnesses
// ---------------------------------------------------------------------------------------------
const cur = () => api('GET', '/cases/current');
const pending = async (kind: string) => ((await cur()).approvals ?? []).some((a: any) => a.kind === kind && a.status === 'pending');
const customerSays = (text: string) => api('POST', '/demo/customer-says', { text });
const REF = 'K7Q2M9';
async function driveToDeal(): Promise<{ ref: string; fee: number; newDay: number }> {
  log('[deal] bill photo -> options -> pick 1 -> limits ok -> lender console');
  await api('POST', '/demo/bill-photo', { fixture: 'brake_quote' });
  await until('options', async () => {
    if (await pending('bill_confirm')) await customerSays('yes');
    return pending('option_choice');
  });
  await customerSays('1');
  await until('limits', () => pending('call_limits'));
  await customerSays('ok');
  await until('text negotiation', async () => {
    const c = (await cur()).case;
    if (!c?.negotiationId) return false;
    return (await api('GET', `/negotiations/${c.negotiationId}`)).channel === 'text';
  });
  const negId = (await cur()).case.negotiationId;
  const lender = async (text: string) => {
    const r = await api('POST', `/negotiations/${negId}/lender`, { text });
    log(`  [console] Lender: ${text}\n${' '.repeat(9)}[console] PacePay: ${r.reply}`);
    return r;
  };
  await lender('We can do Friday, with a twenty dollar fee.');
  const r = await lender('Yes.');
  if (!r.awaitingApproval) throw new Error('no deal approval');
  await until('deal approval', () => pending('deal'), 30_000);
  await customerSays('yes');
  for (let i = 0; i < 80; i++) {
    const n = await api('GET', `/negotiations/${negId}`);
    const last = [...(n.transcript ?? [])].reverse().find((l: any) => l.speaker === 'pacepay')?.text ?? '';
    if (n.state === 'closed') break;
    if (/reference/i.test(last) && n.state !== 'awaiting_approval') {
      await lender(`Sure, your reference number is ${REF}.`);
      break;
    }
    await sleep(500);
  }
  await until('case DONE', async () => (await cur()).case?.state === 'DONE');
  const n = ctx.store.getItem('negotiations', negId);
  const deal = [...n.offers].reverse().find((o: any) => o.readBackConfirmed);
  log(`[deal] outcome=${n.outcome} ref=${n.referenceNumber} fee=${deal?.fee} newDay=${deal?.newDay}`);
  return { ref: n.referenceNumber, fee: deal?.fee ?? 0, newDay: deal?.newDay ?? -1 };
}

// ---------------------------------------------------------------------------------------------
// Expectations, from the engine (buildFacts) so nothing is guessed
// ---------------------------------------------------------------------------------------------
const MON = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
/** "Fri, Nov 13" -> matchers for "Friday, November 13th" / "Nov 13" / "the 13th". */
function dayMatcher(fmt: string): RegExp {
  const m = new RegExp(`(${MON})\\w* (\\d{1,2})`, 'i').exec(fmt);
  if (!m) return new RegExp(fmt.replace(/[^\w ]/g, '.'), 'i');
  return new RegExp(`\\b${m[2]}(st|nd|rd|th)?\\b|${['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen'][Number(m[2])] ?? 'zzz'}`, 'i');
}
/** "$1,234.56" -> a matcher that accepts "$1,234.56", "$1,234", "1234 dollars". */
function moneyMatcher(fmt: string): RegExp {
  const v = fmt.replace(/[^\d.]/g, '');
  const whole = v.split('.')[0]!;
  const commas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return new RegExp(`(${commas}|${whole})(\\.\\d\\d)?`);
}
interface Expect {
  q: string;
  key: string;
  check: (a: string) => string[]; // problems; empty = pass
}
const ACT_LINE = /text me and i'?ll set it up/i;
const NUMBERISH = /\$\s?\d|\d+\s?(dollars|percent|%)|\b\d{1,2}(st|nd|rd|th)\b|reference/i;
const VERDICT_ANY = /\byou can(?:not|'t|’t)?\b(?! (?:check|text|ask|reply|see|call me))|\byou (?:can|could) afford\b|\bthat'?s (?:fine|ok|okay|affordable)\b/i;
function spokenProblems(a: string): string[] {
  const p: string[] = [];
  const sentences = a.split(/(?<=[.!?])\s+/).filter(Boolean).length;
  if (sentences > 3) p.push(`${sentences} sentences (long for a phone line)`);
  if (a.length > 320) p.push(`${a.length} chars`);
  if (/[*#•]|^\s*-\s/m.test(a)) p.push('markdown/bullets');
  if (/\b(FACTS|tool|engine|id)\b/.test(a)) p.push('mentions internals');
  if (/−\$|-\$/.test(a)) p.push('negative amount written "−$" (TTS may misread)');
  return p;
}
function buildExpectations(phase: 'before' | 'after', deal?: { ref: string; fee: number; newDay: number }): Expect[] {
  const facts: string = buildFacts(ctx, '').text;
  const afford: string = buildFacts(ctx, 'Can I afford a $900 bill?').text;
  const low = /Lowest checking in the next 30 days: (\S+) on (\w{3}, \w{3} \d{1,2})/.exec(facts);
  const pay = /Next paycheck: (\S+) on (\w{3}, \w{3} \d{1,2})/.exec(facts);
  const what = /the lowest in the next 30 days would be (\S+) on (\w{3}, \w{3} \d{1,2})/.exec(afford);
  const scores = [...facts.matchAll(/^- (Cash cushion|Emergency fund|Card use|Debt vs\. income): (\S+(?: \w+)?)/gm)].map((m) => ({ label: m[1]!, display: m[2]!.replace(/[.,]$/, '') }));
  const day0 = ctx.store.household().day0Date;
  const fmtDay = (d: number) => {
    const dt = new Date(`${day0}T12:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + d);
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  };
  const has = (a: string, re: RegExp, what: string) => (re.test(a) ? [] : [`missing ${what}`]);
  const lenderAfter = (a: string) =>
    deal ? [...has(a, new RegExp(deal.ref.split('').join('[\\s-]?'), 'i'), `reference ${deal.ref}`), ...has(a, moneyMatcher(`$${(deal.fee / 100).toFixed(2)}`), `fee $${deal.fee / 100}`), ...has(a, dayMatcher(fmtDay(deal.newDay)), `new date ${fmtDay(deal.newDay)}`)] : [];
  const noCallYet = (a: string) => (/\b(no|not|haven'?t|hasn'?t|none|nothing|yet)\b/i.test(a) && !/\$\s?\d/.test(a) ? [] : ['should say plainly no lender call yet (and no figures)']);
  report[`truth_${phase}`] = { lowest: low?.slice(1), paycheck: pay?.slice(1), afford900: what?.slice(1), scores, deal: deal ? { ...deal, newDayFmt: fmtDay(deal.newDay) } : null };
  return [
    { key: 'lender', q: 'What did the lender say?', check: (a) => (phase === 'after' ? lenderAfter(a) : noCallYet(a)) },
    { key: 'lowest', q: "What's the lowest my checking gets this month?", check: (a) => (low ? [...has(a, moneyMatcher(low[1]!), `amount ${low[1]}`), ...has(a, dayMatcher(low[2]!), `day ${low[2]}`)] : ['no truth']) },
    {
      key: 'afford900',
      q: 'Can I afford a $900 bill?',
      check: (a) => [...(what ? [...has(a, moneyMatcher(what[1]!), `lowest after ${what[1]}`), ...has(a, dayMatcher(what[2]!), `day ${what[2]}`)] : ['no truth']), ...(VERDICT_ANY.test(a) ? [`verdict wording: "${VERDICT_ANY.exec(a)![0]}"`] : [])],
    },
    { key: 'paycheck', q: "When's my next paycheck?", check: (a) => (pay ? [...has(a, dayMatcher(pay[2]!), `date ${pay[2]}`), ...has(a, moneyMatcher(pay[1]!), `amount ${pay[1]}`)] : ['no truth']) },
    { key: 'late', q: 'What happens if it’s late?', check: (a) => (/\$\s?\d/.test(a) || /\b(drop|lowest|short|below|overdra|cover)\w*/i.test(a) ? [] : ['no consequence/number given']) },
    { key: 'late_ctx', q: 'What happens if my paycheck is late?', check: (a) => (/\$\s?\d/.test(a) ? [] : ['no number given']) },
    {
      key: 'health',
      q: 'How am I doing?',
      check: (a) => {
        const miss = scores.filter((s) => !a.toLowerCase().includes(s.display.toLowerCase().split(' ')[0]!) && !a.toLowerCase().includes(s.label.toLowerCase().split(' ')[0]!));
        return [...(scores.length === 4 ? [] : [`truth had ${scores.length} scores`]), ...miss.map((s) => `missing ${s.label} (${s.display})`)];
      },
    },
    {
      key: 'car',
      q: 'What did we decide about the car payment?',
      check: (a) => (phase === 'after' && deal ? [...has(a, dayMatcher(fmtDay(deal.newDay)), `new date ${fmtDay(deal.newDay)}`), ...has(a, moneyMatcher(`$${(deal.fee / 100).toFixed(2)}`), 'fee')] : /\b(no|not|haven'?t|nothing|yet)\b/i.test(a) ? [] : ['should say nothing decided yet']),
    },
    { key: 'act_move', q: 'Move my payment to next week.', check: (a) => (ACT_LINE.test(a) ? [] : ['expected "Text me and I\'ll set it up."']) },
    { key: 'act_call', q: 'Call the lender again.', check: (a) => (ACT_LINE.test(a) ? [] : ['expected "Text me and I\'ll set it up."']) },
  ];
}

// ---------------------------------------------------------------------------------------------
// The real InboundConductor over a fake audio port (no LiveKit)
// ---------------------------------------------------------------------------------------------
const { InboundConductor, spokenDigits } = conductorMod;
const client = serverClientMod.createServerClient(base);
interface FakeCall {
  callId: string;
  greeting: string;
  said: { text: string; kind: string; at: number; end: number }[];
  hung?: { at: number; reason: string };
  turn(text: string, ms?: number, barge?: boolean): Promise<{ text: string; kind: string; ms: number; fillerAt?: number; deadAirMs: number } | { hungUp: true; ms: number }>;
}
async function fakeCall(phone = CUSTOMER): Promise<FakeCall> {
  const inbound = await client.inbound({ room: `inboundtest-api-${Date.now()}`, callerPhone: phone });
  inboundIds.add(inbound.callId);
  let playing = 0;
  const said: FakeCall['said'] = [];
  const fc: FakeCall = { callId: inbound.callId, greeting: inbound.greeting, said } as FakeCall;
  const port = {
    // ~15 characters a second of speech, like the TTS voice.
    async speak(text: string, kind: string) {
      const at = Date.now();
      const dur = kind === 'filler' ? 700 : 400 + text.length * 65;
      said.push({ text, kind, at, end: at + dur });
      playing++;
      const playout = sleep(dur).then(() => void playing--);
      return { playout, interrupted: () => false };
    },
    userSpeaking: () => false,
    agentSpeaking: () => playing > 0,
    async hangUp(reason: string) {
      fc.hung = { at: Date.now(), reason };
      await client.event(inbound.callId, { type: 'ended' }).catch(() => undefined);
    },
    log: () => undefined,
  };
  const conductor = new InboundConductor(port, client, inbound.callId);
  fc.turn = async (text: string, ms = 60_000, barge = false) => {
    // A polite caller waits for PacePay to finish; a barge-in talks over the line still playing.
    if (!barge) await until('PacePay quiet', () => playing === 0, 60_000, 25).catch(() => undefined);
    else await until('PacePay talking', () => playing > 0, 10_000, 25).catch(() => undefined);
    const n0 = said.length;
    conductor.onUserState(true);
    await sleep(20);
    conductor.onUserState(false);
    const stop = Date.now();
    conductor.onTranscript(text);
    let line: (typeof said)[number] | undefined;
    await until(`reply to "${text}"`, () => !!fc.hung || !!(line = said.slice(n0).find((s) => s.kind !== 'filler')), ms, 25).catch(() => undefined);
    // Let a goodbye play and the hang-up come.
    if (line?.kind === 'goodbye') await until('hang-up', () => !!fc.hung, 20_000, 25).catch(() => undefined);
    const filler = said.slice(n0).find((s) => s.kind === 'filler');
    if (!line) return { hungUp: true as const, ms: Date.now() - stop };
    const deadAirMs = filler ? Math.max(filler.at - stop, line.at - filler.end) : line.at - stop;
    return { text: line.text, kind: line.kind, ms: line.at - stop, ...(filler ? { fillerAt: filler.at - stop } : {}), deadAirMs };
  };
  return fc;
}

async function runApi(): Promise<void> {
  const OK = /you are verified/i;
  // 1) Spoken PIN variants, as the transcriber may write them. Each in a fresh call.
  const pass = [
    '1 2 3 4', '1 2 3 4.', '1234', '1234.', '1,234', 'One two three four.', 'one, two, three, four', 'One. Two. Three. Four.',
    'Twelve thirty-four.', 'twelve thirty four', 'Twelve, thirty-four.', '12 34', '12, 34.', 'One-two-three-four.', '1-2-3-4.',
    'Uh, one two three four.', 'Um, my PIN is 1234.', "It's one two three four.", 'Uh... one, two... three, four.', 'one two three for',
    'won two three four', 'The PIN is twelve thirty four.', 'Yeah, one two three four, sorry, noisy here.',
  ];
  const fail = ['1 2 3 5', 'Four three two one.', '5678', 'Thirteen thirty-four.', 'one two three four five'];
  const pinRows: any[] = [];
  for (const [variant, want] of [...pass.map((v) => [v, true] as const), ...fail.map((v) => [v, false] as const)]) {
    const c = await fakeCall();
    const r: any = await c.turn(variant);
    const ok = OK.test(r.text ?? '');
    pinRows.push({ variant, digits: spokenDigits(variant), want: want ? 'pass' : 'fail', got: ok ? 'pass' : 'fail', say: r.text, ms: r.ms, result: ok === want ? 'OK' : 'WRONG' });
    log(`[pin] ${ok === want ? 'OK   ' : 'WRONG'} "${variant}" -> digits="${spokenDigits(variant)}" -> "${r.text}" (${r.ms} ms)`);
  }
  report.pinVariants = pinRows;

  // 2) Three wrong PINs: polite goodbye, then the hang-up after it has played.
  {
    const c = await fakeCall();
    const rows: any[] = [];
    for (const v of ['One two three five.', 'Four four four four.', 'Nine eight seven six.']) rows.push({ said: v, ...(await c.turn(v)) });
    const bye = c.said.find((s) => s.kind === 'goodbye');
    const hangAfterBye = c.hung && bye ? c.hung.at - bye.end : null;
    // A 4th try after the goodbye must not verify, and the server backstop hang-up must be armed.
    const after = await client.verifyPin(c.callId, PIN);
    report.threeWrong = { rows, goodbye: bye?.text, hungUp: !!c.hung, hangUpMsAfterGoodbyeEnded: hangAfterBye, fourthTryWithRightPin: after, callRow: ctx.store.getItem('calls', c.callId)?.status };
    log(`[3wrong] ${JSON.stringify(report.threeWrong)}`);
  }

  // 3) Wrong caller ID: greeting, the right PIN, a question.
  {
    const c = await fakeCall(STRANGER);
    const pin = await c.turn('1 2 3 4.');
    const q: any = await c.turn('What did the lender say?');
    const direct = await api('POST', `/voice/calls/${c.callId}/ask`, { question: 'What is my checking balance?' });
    report.wrongCaller = { greeting: c.greeting, pinReply: pin, question: q, directAsk: direct };
    log(`[stranger] ${JSON.stringify(report.wrongCaller)}`);
  }

  // 4) Before the PIN: a question gets the PIN prompt; /ask straight away gets no numbers.
  {
    const c = await fakeCall();
    const q: any = await c.turn('What did the lender say?');
    const direct = await api('POST', `/voice/calls/${c.callId}/ask`, { question: "What's my checking balance?" });
    report.prePin = { greeting: c.greeting, conductorReply: q, directAsk: direct, numbersLeaked: NUMBERISH.test(`${q.text} ${direct.say}`) };
    log(`[pre-pin] ${JSON.stringify(report.prePin)}`);
  }

  // 5) Question battery, before any lender call and after a completed deal.
  async function battery(phase: 'before' | 'after', deal?: { ref: string; fee: number; newDay: number }, extraDemo = 0) {
    const exps = buildExpectations(phase, deal);
    const rows: any[] = [];
    const c = await fakeCall();
    const pin: any = await c.turn('1 2 3 4.');
    if (!OK.test(pin.text ?? '')) throw new Error(`PIN did not verify: ${JSON.stringify(pin)}`);
    const list = [...exps, ...Array.from({ length: extraDemo }, () => exps[0]!)];
    for (const x of list) {
      const r: any = await c.turn(x.q, 90_000);
      const problems = r.text ? [...x.check(r.text), ...spokenProblems(r.text)] : ['no answer'];
      rows.push({ phase, key: x.key, q: x.q, a: r.text, ms: r.ms, fillerAt: r.fillerAt, deadAirMs: r.deadAirMs, problems, pass: problems.length === 0 });
      log(`[${phase}] ${problems.length ? 'FAIL' : 'PASS'} ${x.key} (${r.ms} ms, dead air ${r.deadAirMs} ms) "${x.q}" -> "${r.text}"${problems.length ? `  !! ${problems.join('; ')}` : ''}`);
    }
    const bye: any = await c.turn("Okay, that's all, bye.");
    const g = c.said.find((s) => s.kind === 'goodbye');
    rows.push({ phase, key: 'goodbye', q: "Okay, that's all, bye.", a: g?.text, hungUp: !!c.hung, hangUpMsAfterGoodbyeEnded: c.hung && g ? c.hung.at - g.end : null, pass: !!c.hung && !!g && c.hung.at >= g.end });
    log(`[${phase}] goodbye: ${JSON.stringify(rows.at(-1))} ${JSON.stringify(bye)}`);
    return rows;
  }
  const before = await battery('before');
  const deal = await driveToDeal();
  const after = await battery('after', deal, 3);
  report.battery = [...before, ...after];
  // Barge-in: a follow-up asked while the long answer is still playing (it shares many of its words).
  {
    const c = await fakeCall();
    await c.turn('1 2 3 4.');
    const first: any = await c.turn('What happens if my paycheck is late?', 60_000);
    await sleep(300);
    const follow: any = await c.turn('So what happens if my paycheck is late by two days?', 30_000, true);
    report.bargeIn = { first, follow, answered: !!follow.text };
    log(`[barge] first="${first.text}" follow-up while it played -> ${follow.text ? `"${follow.text}" (${follow.ms} ms)` : 'NO ANSWER (dropped as echo?)'}`);
  }
}

// ---------------------------------------------------------------------------------------------
// voice: one test worker, 10 inbound calls over LiveKit
// ---------------------------------------------------------------------------------------------
async function runVoice(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const rtc: any = await import(pkg('@livekit/rtc-node'));
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  const lk: any = await import(pkg('livekit-server-sdk'));
  const lkHttp = e.LIVEKIT_URL!.replace(/^wss:/, 'https:');
  const dispatchClient = new lk.AgentDispatchClient(lkHttp, e.LIVEKIT_API_KEY, e.LIVEKIT_API_SECRET);
  lkRooms = new lk.RoomServiceClient(lkHttp, e.LIVEKIT_API_KEY, e.LIVEKIT_API_SECRET);

  const deal = await driveToDeal();
  report.deal = deal;

  // The worker, once, for all 10 calls.
  const marks: { name: string; at: number; extra: string }[] = [];
  const workerLog: { at: number; text: string }[] = [];
  let ready!: () => void;
  const readyP = new Promise<void>((r) => (ready = r));
  const worker: ChildProcess = spawn(join(VOICE, 'node_modules/.bin/tsx'), [join(VOICE, 'src/agent.ts'), 'start'], {
    cwd: VOICE,
    env: { ...process.env, PACEPAY_VOICE_AGENT_NAME: TEST_AGENT, PACEPAY_VOICE_PORT: String(port + 1), SERVER_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let workerExited: number | null = null;
  worker.on('exit', (code) => (workerExited = code ?? -1));
  const onWorker = (buf: Buffer) => {
    for (const l of buf.toString().split('\n')) {
      if (!l.trim()) continue;
      if (/registered worker/i.test(l)) ready();
      if (l.includes('[voice]')) {
        const text = l.replace(/^\S+ \[voice\] /, '');
        const mk = /^t:(\w+) (\d+)\s*(.*)$/.exec(text);
        if (mk) {
          marks.push({ name: mk[1]!, at: Number(mk[2]), extra: mk[3] ?? '' });
          continue;
        }
        workerLog.push({ at: Date.now(), text });
        if (process.env.VERBOSE || /say \(|turn \d+:|TTS|ignored|skipped|dropped|blocked|failed|error|ended|joined/i.test(text)) log(`  [worker] ${text}`);
      } else if (process.env.VERBOSE || /"level":(4|5)0|error|unhandled/i.test(l)) {
        workerLog.push({ at: Date.now(), text: `[log] ${l.slice(0, 300)}` });
        log(`  [worker-log] ${l.slice(0, 300)}`);
      }
    }
  };
  worker.stdout!.on('data', onWorker);
  worker.stderr!.on('data', onWorker);
  await Promise.race([readyP, sleep(40_000).then(() => { throw new Error('test worker did not register'); })]);
  log(`[voice] test worker registered as ${TEST_AGENT} (pid ${worker.pid})`);

  // Caller audio (OpenAI TTS), cached by line.
  const RATE = 24_000;
  const FRAME = 480;
  const ttsCache = new Map<string, Int16Array>();
  async function tts(text: string): Promise<Int16Array> {
    const hit = ttsCache.get(text);
    if (hit) return hit;
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${e.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts-2025-12-15', voice: 'ash', input: text, response_format: 'pcm', instructions: 'A relaxed young man on his cell phone, calling his own money assistant. Natural pace.' }),
    });
    if (!r.ok) throw new Error(`caller TTS ${r.status}`);
    const b = new Uint8Array(await r.arrayBuffer());
    const pcm = new Int16Array(b.buffer, b.byteOffset, b.length >> 1);
    const W = 480;
    const rms = (i: number) => {
      let q = 0;
      for (let j = i; j < Math.min(pcm.length, i + W); j++) q += pcm[j]! * pcm[j]!;
      return Math.sqrt(q / W);
    };
    let s = 0;
    let t = Math.max(0, pcm.length - W);
    while (s < pcm.length && rms(s) < 400) s += W;
    while (t > s && rms(t) < 400) t -= W;
    const out = pcm.slice(Math.max(0, s - W), Math.min(pcm.length, t + 2 * W));
    ttsCache.set(text, out);
    return out;
  }
  async function transcribe(chunks: Int16Array[]): Promise<string> {
    const n = chunks.reduce((k, c) => k + c.length, 0);
    if (!n) return '';
    const pcm = new Int16Array(n);
    let o = 0;
    for (const c of chunks) {
      pcm.set(c, o);
      o += c.length;
    }
    const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0);
    h.writeUInt32LE(36 + data.length, 4);
    h.write('WAVEfmt ', 8);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(RATE, 24);
    h.writeUInt32LE(RATE * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36);
    h.writeUInt32LE(data.length, 40);
    const form = new FormData();
    form.append('file', new Blob([Buffer.concat([h, data])], { type: 'audio/wav' }), 'a.wav');
    form.append('model', 'gpt-4o-mini-transcribe');
    form.append('language', 'en');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${e.OPENAI_API_KEY}` }, body: form });
    return r.ok ? ((await r.json()) as { text: string }).text : `[transcription failed ${r.status}]`;
  }

  interface CallPlan {
    name: string;
    phone: string;
    noise?: number; // rms of background noise mixed in (speech peaks ~5-10k)
    lines: string[];
    callerHangsUp?: boolean;
    expect: string;
  }
  const PLAN: CallPlan[] = [
    { name: 'demo 1 2 3 4', phone: CUSTOMER, lines: ['1 2 3 4.', 'What did the lender say?', "Okay, that's all, bye."], expect: 'verified; lender answer with date, fee, ref; goodbye then hang-up' },
    { name: 'twelve thirty-four', phone: CUSTOMER, lines: ['Twelve thirty-four.', "What's the lowest my checking gets this month?", 'Thanks, bye.'], expect: 'verified; lowest + day' },
    { name: 'three wrong PINs', phone: CUSTOMER, lines: ['One two three five.', 'Four four four four.', 'Nine eight seven six.'], expect: 'retry, retry, goodbye + hang-up' },
    { name: 'noisy one-two-three-four', phone: CUSTOMER, noise: 600, lines: ['Uh, one-two-three-four.', 'Can I afford a nine hundred dollar bill?', 'Bye.'], expect: 'verified under noise; numbers, no verdict' },
    { name: 'one two three four', phone: CUSTOMER, lines: ['One two three four.', "When's my next paycheck?", 'What happens if it’s late?', 'Okay, bye.'], expect: 'verified; paycheck; late' },
    { name: 'wrong caller ID', phone: STRANGER, lines: ['1 2 3 4.', 'What did the lender say?', 'Bye.'], expect: 'account-holder line, no numbers' },
    { name: 'noisy health', phone: CUSTOMER, noise: 900, lines: ['1 2 3 4.', 'How am I doing?', 'Bye.'], expect: 'verified under heavier noise; four scores' },
    { name: 'act request', phone: CUSTOMER, lines: ['Twelve thirty-four.', 'Move my payment to next week.', 'Bye.'], expect: '"Text me and I\'ll set it up."' },
    { name: 'car payment', phone: CUSTOMER, lines: ['1 2 3 4.', 'What did we decide about the car payment?', 'Bye.'], expect: 'new date + fee' },
    { name: 'demo, caller hangs up', phone: CUSTOMER, lines: ['1 2 3 4.', 'What did the lender say?'], callerHangsUp: true, expect: 'answer, then the worker ends the call when the caller drops' },
  ];
  // Pre-render every caller line.
  await Promise.all([...new Set(PLAN.flatMap((p) => p.lines))].map((l) => tts(l)));

  const results: any[] = [];
  for (let i = 0; i < PLAN.length; i++) {
    const p = PLAN[i]!;
    if (workerExited !== null) {
      results.push({ call: i + 1, name: p.name, error: `worker exited (${workerExited})` });
      break;
    }
    log(`\n[voice] === call ${i + 1}/${PLAN.length}: ${p.name} (${p.noise ? `noise rms ${p.noise}` : 'clean'}) ===`);
    const room = `inboundtest-${port}-${i + 1}-${Date.now()}`;
    const r: any = { call: i + 1, name: p.name, expect: p.expect, room, turns: [] };
    const caller = new rtc.Room();
    const source = new rtc.AudioSource(RATE, 1, 60);
    const queue: Int16Array[] = [];
    let talking = false;
    let stoppedAt = 0;
    let pumpOn = true;
    const noise = (n: number) => {
      // Crowd-ish noise: smoothed random, a little bursty.
      const f = new Int16Array(FRAME);
      let prev = 0;
      const burst = Math.random() < 0.08 ? 2.2 : 1;
      for (let k = 0; k < FRAME; k++) {
        prev = prev * 0.6 + (Math.random() * 2 - 1) * 0.4;
        f[k] = Math.max(-32768, Math.min(32767, Math.round(prev * n * 2.5 * burst)));
      }
      return f;
    };
    const pump = async () => {
      while (pumpOn) {
        const f = p.noise ? noise(p.noise) : new Int16Array(FRAME);
        const c = queue[0];
        if (c) {
          talking = true;
          const chunk = c.subarray(0, FRAME);
          queue[0] = c.subarray(FRAME);
          if (!queue[0]!.length) queue.shift();
          for (let k = 0; k < chunk.length; k++) f[k] = Math.max(-32768, Math.min(32767, f[k]! + chunk[k]!));
          if (!queue.length) {
            talking = false;
            stoppedAt = Date.now() + 60;
          }
        }
        await source.captureFrame(new rtc.AudioFrame(f, RATE, 1, FRAME));
      }
    };
    // PacePay's audio: loud-frame times + segments.
    const loud: number[] = [];
    const segs: { start: number; end: number; pcm: Int16Array[] }[] = [];
    let seg: { start: number; end: number; pcm: Int16Array[] } | undefined;
    let lastLoud = 0;
    caller.on(rtc.RoomEvent.TrackSubscribed, (track: any) => {
      if (track.kind !== rtc.TrackKind.KIND_AUDIO) return;
      void (async () => {
        const stream = new rtc.AudioStream(track, { sampleRate: RATE, numChannels: 1 });
        for await (const f of stream) {
          const d: Int16Array = f.data;
          let sum = 0;
          for (let k = 0; k < d.length; k++) sum += d[k]! * d[k]!;
          const now = Date.now();
          if (Math.sqrt(sum / Math.max(1, d.length)) > 300) {
            lastLoud = now;
            loud.push(now);
            if (!seg) seg = { start: now, end: now, pcm: [] };
          }
          if (seg) {
            seg.pcm.push(new Int16Array(d));
            if (now - lastLoud > 1_000) {
              seg.end = lastLoud;
              segs.push(seg);
              seg = undefined;
            }
          }
        }
      })();
    });
    let goneAt = 0;
    caller.on(rtc.RoomEvent.Disconnected, () => (goneAt ||= Date.now()));
    const tDispatch = Date.now();
    try {
      await dispatchClient.createDispatch(room, TEST_AGENT, {});
      const at = new lk.AccessToken(e.LIVEKIT_API_KEY, e.LIVEKIT_API_SECRET, { identity: `sip_${p.phone.replace(/\D/g, '').slice(-4) || 'x'}`, attributes: { 'sip.phoneNumber': p.phone } });
      at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
      await caller.connect(e.LIVEKIT_URL, await at.toJwt(), { autoSubscribe: true, dynacast: false });
      const tJoined = Date.now();
      const track = rtc.LocalAudioTrack.createAudioTrack('mic', source);
      const opts = new rtc.TrackPublishOptions();
      opts.source = rtc.TrackSource.SOURCE_MICROPHONE;
      await caller.localParticipant.publishTrack(track, opts);
      void pump();
      await until('inbound call row', () => ctx.store.list('calls').some((c: any) => c.room === room), 30_000, 100);
      const callId = ctx.store.list('calls').find((c: any) => c.room === room).id;
      inboundIds.add(callId);
      r.callId = callId;
      await until('greeting audio', () => loud.length > 0, 30_000, 20);
      r.greetingMsFromDispatch = loud[0]! - tDispatch;
      r.greetingMsFromJoin = loud[0]! - tJoined;
      const pacepayLines = () => (ctx.store.getItem('calls', callId)?.transcript ?? []).filter((l: any) => l.speaker === 'pacepay');
      await until('greeting played', () => !!seg === false && Date.now() - lastLoud > 1_000 && loud.length > 0, 30_000, 50);
      r.greeting = pacepayLines()[0]?.text;
      log(`[voice] greeting after ${r.greetingMsFromDispatch} ms from dispatch (${r.greetingMsFromJoin} ms from join): "${r.greeting}"`);

      for (const line of p.lines) {
        if (goneAt) break;
        await sleep(400);
        const n0 = pacepayLines().length;
        const marks0 = marks.length;
        log(`CALLER : ${line}`);
        queue.push(ttsCache.get(line)!);
        await until('caller line played', () => !talking && !queue.length, 30_000, 20);
        const stop = stoppedAt;
        // A real (posted) PacePay line after this turn, played out, or the room closing.
        await until(`PacePay answer to "${line}"`, () => goneAt > 0 || (pacepayLines().length > n0 && !seg && Date.now() - lastLoud > 1_000 && lastLoud > stop), 90_000, 50).catch((err) => log(`  !! ${err.message}`));
        const reply = pacepayLines()[n0]?.text;
        const newMarks = marks.slice(marks0);
        const ff = newMarks.filter((m) => m.name === 'first_frame');
        const fillerMark = ff.find((m) => m.extra.startsWith('filler'));
        const replyMark = ff.find((m) => !m.extra.startsWith('filler'));
        // First loud audio after the caller stopped, and the reply's audio onset (first loud after its first frame).
        const firstAudio = loud.find((t) => t > stop);
        const replyAudio = replyMark ? loud.find((t) => t >= replyMark.at) : undefined;
        // Dead air: the longest stretch of silence between the caller stopping and the reply starting.
        let deadAir = 0;
        if (replyAudio) {
          let prev = stop;
          for (const t of loud.filter((x) => x > stop && x <= replyAudio)) {
            deadAir = Math.max(deadAir, t - prev);
            prev = t;
          }
          deadAir = Math.max(deadAir, replyAudio - prev);
        }
        const turn = {
          caller: line,
          pacepay: reply,
          kind: replyMark?.extra.split(' ')[0],
          firstAudioMs: firstAudio ? firstAudio - stop : null,
          fillerMs: fillerMark ? fillerMark.at - stop : null,
          replyAudioMs: replyAudio ? replyAudio - stop : null,
          deadAirMs: replyAudio ? deadAir : null,
          vadEndMs: (() => {
            const v = newMarks.find((m) => m.name === 'vad_end');
            return v ? v.at - stop : null;
          })(),
          transcriptMs: (() => {
            const v = newMarks.find((m) => m.name === 'transcript');
            return v ? v.at - stop : null;
          })(),
          decidedMs: (() => {
            const v = newMarks.find((m) => m.name === 'decided');
            return v ? v.at - stop : null;
          })(),
          heard: (ctx.store.getItem('calls', callId)?.transcript ?? []).filter((l: any) => l.speaker === 'customer').slice(-1)[0]?.text,
        };
        r.turns.push(turn);
        log(`  -> PacePay (${turn.kind ?? '-'}): "${reply ?? '(nothing)'}"  [first audio ${turn.firstAudioMs} ms, filler ${turn.fillerMs ?? '-'} ms, reply ${turn.replyAudioMs} ms, dead air ${turn.deadAirMs} ms; heard "${turn.heard}"]`);
      }
      if (p.callerHangsUp) {
        await sleep(800);
        log('CALLER : (hangs up)');
        const tHang = Date.now();
        pumpOn = false;
        await caller.disconnect();
        await until('call row ended', () => ctx.store.getItem('calls', callId)?.status === 'ended', 20_000, 100).catch(() => undefined);
        r.endedAfterCallerHangUpMs = ctx.store.getItem('calls', callId)?.status === 'ended' ? Date.now() - tHang : null;
      } else {
        await until('PacePay hangs up', () => goneAt > 0, 30_000, 50).catch((err) => (r.error = err.message));
      }
      if (seg) segs.push(seg);
      // Hang-up vs the goodbye: the last PacePay segment must be the goodbye and must have ended before the room closed.
      const goodbyeMark = [...marks].reverse().find((m) => m.name === 'first_frame' && m.extra.startsWith('goodbye') && m.at >= tDispatch);
      const last = segs.at(-1);
      r.lastSegmentHeard = last ? await transcribe(last.pcm) : '';
      r.goodbyeFirstFrameToHangUpMs = goodbyeMark && goneAt ? goneAt - goodbyeMark.at : null;
      r.lastAudioToHangUpMs = goneAt && lastLoud ? goneAt - lastLoud : null;
      r.hungUpByPacePay = !p.callerHangsUp && goneAt > 0;
      r.cutMidLine = goneAt > 0 && goneAt - lastLoud < 150;
      const row = ctx.store.getItem('calls', callId);
      r.callRow = { status: row?.status, pinVerified: !!row?.pinVerified, outcome: row?.outcome, transcriptLines: row?.transcript?.length };
      r.serverBackstopHangUps = hangUps.filter((h) => h.room === room).length;
      log(`[voice] call ${i + 1} done: hung up ${r.lastAudioToHangUpMs} ms after the last audio; last heard "${r.lastSegmentHeard}"; row ${JSON.stringify(r.callRow)}`);
    } catch (err) {
      r.error = (err as Error).message;
      log(`[voice] call ${i + 1} FAILED: ${r.error}`);
    }
    pumpOn = false;
    await caller.disconnect().catch(() => undefined);
    await lkRooms.deleteRoom(room).catch(() => undefined);
    r.workerAlive = workerExited === null;
    results.push(r);
    await sleep(1500);
  }
  report.calls = results;
  report.workerErrors = workerLog.filter((l) => /error|failed|unhandled|blocked/i.test(l.text)).map((l) => l.text).slice(0, 40);
  report.workerSurvived = workerExited === null;
  worker.kill('SIGINT');
  await sleep(2000);
  worker.kill('SIGKILL');
}

// ---------------------------------------------------------------------------------------------
try {
  if (mode === 'api') await runApi();
  else if (mode === 'voice') await runVoice();
  else throw new Error(`unknown mode ${mode}`);
} catch (err) {
  report.fatal = (err as Error).message;
  log(`[inbound] FATAL: ${(err as Error).stack}`);
}
report.busEvents = busEvents;
// Distinct event shapes for the dashboard.
const shapes = new Map<string, any>();
for (const b of busEvents) {
  const k = b.sse === 'activity' ? `activity:${b.type}:${(b.title ?? '').replace(/\d+/g, 'N').replace(/: .*/, ': ...')}` : `call:${b.callStatus}:${b.pinVerified ? 'pin' : 'nopin'}`;
  if (!shapes.has(k)) shapes.set(k, b);
}
report.eventShapes = [...shapes.values()];
mkdirSync(OUT, { recursive: true });
const file = join(OUT, `inbound-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));
log(`[inbound] report: ${file}`);
server.close();
process.exit(report.fatal ? 1 : 0);
