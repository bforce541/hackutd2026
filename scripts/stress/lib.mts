/**
 * Shared helpers for the stress harness (run.mts) and grader (grade.mts). Test tooling only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';

export const REPO = '/Users/ramsarma/hackutd26';
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Persona + result types
// ---------------------------------------------------------------------------

export interface Persona {
  id: string;
  category: string;
  title: string;
  realism_note?: string;
  behavior: string;
  asr_noise?: number;
  max_turns?: number;
  yoshua?: {
    limits_reply?: string;
    approval_reply?: string; // yes | no | silent | text:<exact>
    approval_delay_s?: number;
    extra_texts?: { at_turn: number; text: string }[];
  };
  expect?: {
    outcome?: 'deal' | 'no_deal' | 'callback' | 'handoff' | 'any';
    deal_terms?: { day: string; fee: number } | null;
    must?: string[];
    must_not?: string[];
  };
}

export type Source = 'greeting' | 'decide' | 'approval' | 'hold_update' | 'filler' | 'goodbye' | 'fallback' | 'worker';
export interface CallLine {
  who: 'pacepay' | 'lender';
  text: string; // lender: what they actually said; pacepay: the exact spoken line
  heard?: string; // lender: what speech-to-text delivered to PacePay (after asr mangling)
  asr?: string[]; // which manglings were applied
  garbled?: boolean; // the heard text is no longer intelligible
  kind?: string; // the worker's line kind (greeting/reply/hold/approval/filler/goodbye)
  source?: Source;
  turn: number; // lender turn index this belongs to
  t: number; // ms since call start
}
export interface TextMsg {
  dir: 'in' | 'out';
  text: string;
  at: string;
  t?: number; // ms since call start (negative = before the call)
  approvalReply?: boolean;
}
export interface RunResult {
  persona: Persona;
  ok: boolean; // the harness itself worked (not whether PacePay passed)
  error?: string;
  endReason?: string; // negotiator_end | lender_hangup | max_turns | worker_fallback | error
  call: CallLine[];
  texts: TextMsg[]; // every text to/from Yoshua from the start of the call on
  textsBefore?: TextMsg[];
  negotiation?: any;
  approvals?: any[]; // deal approvals of this call
  acceptedChanges?: any[];
  acceptedChangesBefore?: any[];
  callStartAt?: string;
  lender?: string; // which model played the lender
  caseState?: string;
  callRow?: any;
  callPlan?: any;
  workerLog?: string[];
  decideLog?: { utterance: string; say: string; next: string; state?: string; ms: number; t: number; dtmf?: string; [k: string]: unknown }[];
  approvalPolls?: { status: string; say?: string; next?: string; t: number }[];
  timings: { setupMs: number; callMs: number; postMs: number; totalMs: number; lenderLlmMs: number; decideMs: number[] };
  grade?: Grade;
}
export interface Issue {
  check: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  detail: string;
  line?: string;
  cause?: string; // root-cause cluster key
  by: 'rule' | 'judge';
}
export interface Grade {
  pass: boolean;
  issues: Issue[];
  judge?: { capable_human_score?: number; met_expectations?: boolean; summary?: string; error?: string; by?: string };
  facts: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Deterministic RNG + ASR mangling
// ---------------------------------------------------------------------------

export function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
export function rng(seed: number): () => number {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Phone speech-to-text confusions (realistic ones from the call logs plus classic homophones). */
const HOMOPHONES: [RegExp, string[]][] = [
  [/\bFriday\b/gi, ['Fried a', 'fry day', 'Friday', 'Freddy']],
  [/\bthirteenth\b/gi, ['thirtieth', '13th', 'thirteen']],
  [/\bfifteen\b/gi, ['fifty', '15']],
  [/\bfifty\b/gi, ['fifteen', '50']],
  [/\bthirty\b/gi, ['thirteen', '30']],
  [/\bforty\b/gi, ['fourteen', '40']],
  [/\btwenty\b/gi, ['plenty', '20', 'twenty']],
  [/\bfee\b/gi, ['V', 'free', 'fee']],
  [/\bno fee\b/gi, ['know fee', 'no V', 'no free']],
  [/\bwaive\b/gi, ['wave', 'waved']],
  [/\bwaived\b/gi, ['waved', 'paved']],
  [/\bto\b/gi, ['two', 'too']],
  [/\bfor\b/gi, ['four']],
  [/\bcan't\b/gi, ['can', 'cant']],
  [/\bWednesday\b/gi, ['Wednesdays', 'when\'s day']],
  [/\bThursday\b/gi, ['Thirsty', 'Thursdays']],
  [/\bTuesday\b/gi, ['two days', 'Tuesdays']],
  [/\bMonday\b/gi, ['Monday\'s', 'one day']],
  [/\breference\b/gi, ['preference', 'reverence']],
  [/\bconfirmation\b/gi, ['conformation', 'confirm Asian']],
  [/\bdollars\b/gi, ['dollar', 'bucks', 'dolls']],
  [/\bthe 13th\b/gi, ['the thirtieth', 'that thirteenth']],
  [/\bsixteenth\b/gi, ['sixtieth', '16']],
  [/\bseventeenth\b/gi, ['seventieth', '17']],
];
const FILLERS = ['uh', 'um', 'so', 'like', 'yeah'];

export interface Mangled {
  heard: string;
  ops: string[];
  garbled: boolean;
  fragments?: string[]; // the turn arrived as two transcripts
}

/** Mangle one lender turn the way phone ASR does. Deterministic for a given rand stream. */
export function mangle(text: string, noise: number, rand: () => number): Mangled {
  const ops: string[] = [];
  let heard = text;
  if (noise <= 0 || rand() >= noise) return { heard, ops, garbled: false };
  const nOps = 1 + Math.floor(rand() * 2);
  for (let k = 0; k < nOps; k++) {
    const r = rand();
    if (r < 0.5) {
      const hits = HOMOPHONES.filter(([re]) => {
        re.lastIndex = 0;
        return re.test(heard);
      });
      if (hits.length) {
        const [re, subs] = hits[Math.floor(rand() * hits.length)]!;
        const sub = subs[Math.floor(rand() * subs.length)]!;
        re.lastIndex = 0;
        heard = heard.replace(re, (m) => (rand() < 0.7 ? sub : m));
        ops.push(`homophone:${re.source}->${sub}`);
        continue;
      }
    }
    if (r < 0.7) {
      const words = heard.split(/\s+/);
      if (words.length > 4) {
        const i = 1 + Math.floor(rand() * (words.length - 2));
        ops.push(`drop:${words[i]}`);
        words.splice(i, 1);
        heard = words.join(' ');
        continue;
      }
    }
    if (r < 0.82) {
      // numbers to digits or digits to words (both happen)
      if (/\$\d+/.test(heard)) {
        heard = heard.replace(/\$(\d+)/, (_, d) => `${d}`);
        ops.push('dollar-sign-dropped');
      } else {
        heard = heard.replace(/\b(twenty|thirty|fifteen|ten|twenty-five|thirty-five)\b/i, (m) => ({ twenty: '20', thirty: '30', fifteen: '15', ten: '10', 'twenty-five': '25', 'thirty-five': '35' } as Record<string, string>)[m.toLowerCase()] ?? m);
        ops.push('numbers-as-digits');
      }
      continue;
    }
    if (r < 0.92) {
      const words = heard.split(/\s+/);
      const i = Math.floor(rand() * words.length);
      words.splice(i, 0, FILLERS[Math.floor(rand() * FILLERS.length)]!);
      heard = words.join(' ');
      ops.push('filler-inserted');
      continue;
    }
    // punctuation lost + lowercased (very common)
    heard = heard.toLowerCase().replace(/[.,!?;:]/g, '');
    ops.push('no-punctuation');
  }
  const out: Mangled = { heard, ops, garbled: false };
  // Sometimes the turn arrives split in two transcripts (a pause mid-sentence).
  const words = heard.split(/\s+/);
  if (words.length >= 8 && rand() < noise) {
    const cut = 3 + Math.floor(rand() * (words.length - 5));
    out.fragments = [words.slice(0, cut).join(' '), words.slice(cut).join(' ')];
    ops.push(`split@${cut}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Terms parsing (money + days) used by the grader
// ---------------------------------------------------------------------------

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORD: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
  thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20,
  'twenty-first': 21, 'twenty-second': 22, 'twenty-third': 23, 'twenty-fourth': 24, 'twenty-fifth': 25, 'twenty-sixth': 26,
  'twenty-seventh': 27, 'twenty-eighth': 28, thirtieth: 30,
};

/** "twenty-five dollars" -> "25 dollars"; "thirty five" -> "35". Ordinals are left alone. */
export function digitizeWords(s: string): string {
  return s
    .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-]+(one|two|three|four|five|six|seven|eight|nine)\b/gi, (_, t, o) => String(TENS[t.toLowerCase()]! + ONES[o.toLowerCase()]!))
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/gi, (m) => String(ONES[m.toLowerCase()] ?? TENS[m.toLowerCase()]));
}

/** Fee amounts (whole dollars) a line states. 0 for "no fee"/"waive"/"free". */
export function feesIn(text: string): number[] {
  const out: number[] = [];
  const t = digitizeWords(text.replace(/,(?=\d{3})/g, ''));
  if (/\b(no|without( a| any)?|zero|0) (fee|charge|cost)s?\b|\bwaiv(e|ed|ing)\b|\bfree of charge\b|\bno[- ]charge\b|\bat no cost\b|\bno cost\b|\bfee[- ]free\b/i.test(t)) out.push(0);
  const re = /\$\s?(\d{1,4})(?:\.(\d{2}))?|\b(\d{1,4})(?:\.(\d{2}))?\s?(?:dollars?|bucks|usd)\b|\b(?:fee|charge)\s(?:of|is|would be|will be|is gonna be|of about|of like)?\s?\$?(\d{1,4})\b|\b(\d{1,3})\s(?:dollar\s)?(?:fee|charge)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const v = Number(m[1] ?? m[3] ?? m[5] ?? m[6]);
    if (Number.isFinite(v)) out.push(v);
  }
  return [...new Set(out)];
}

const WEEKDAY: Record<string, number> = { sunday: 8, monday: 9, tuesday: 10, wednesday: 11, thursday: 12, friday: 13, saturday: 14 };
const WD_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Day of November 2026 -> "Fri Nov 13". */
export function dayLabel(dom: number): string {
  const wd = (dom + 6) % 7; // Nov 1 2026 is a Sunday
  return `${WD_NAMES[wd]} Nov ${dom}`;
}
/** Days (day of month, November 2026) a line names. Weekday names map to the coming one. */
export function daysIn(text: string): number[] {
  const out: number[] = [];
  const t = text.toLowerCase();
  // "Fri, Nov 13", "November 13th", "the 13th", "the thirteenth", "13th"
  let m: RegExpExecArray | null;
  const reNum = /\b(?:nov(?:ember)?\.?\s+)?(\d{1,2})(?:st|nd|rd|th)\b|\bnov(?:ember)?\.?\s+(\d{1,2})\b/g;
  while ((m = reNum.exec(t))) {
    const v = Number(m[1] ?? m[2]);
    if (v >= 1 && v <= 30) out.push(v);
  }
  for (const [w, v] of Object.entries(ORD)) if (new RegExp(`\\b(the |on the )${w}\\b`).test(t) || new RegExp(`\\bnov(ember)? ${w}\\b`).test(t)) out.push(v);
  const named: number[] = [];
  for (const [w, v] of Object.entries(WEEKDAY)) {
    if (new RegExp(`\\b${w}\\b|\\b${w.slice(0, 3)}\\b(?!\\w)`).test(t)) named.push(new RegExp(`next ${w}`).test(t) ? v : v);
  }
  // a weekday next to an explicit date ("Friday the 13th") is the same day: keep the date only.
  if (!out.length) out.push(...named);
  return [...new Set(out)];
}
export interface Terms {
  day?: number;
  fee?: number;
}
/** One set of terms per line: the last day and the last fee it states (null when none). */
export function termsIn(text: string): Terms {
  const d = daysIn(text);
  const f = feesIn(text);
  const out: Terms = {};
  if (d.length) out.day = d[d.length - 1];
  if (f.length) out.fee = f[f.length - 1];
  return out;
}

// ---------------------------------------------------------------------------
// Concurrency + backoff for model calls
// ---------------------------------------------------------------------------

export class Semaphore {
  private q: (() => void)[] = [];
  private n = 0;
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.n >= this.max) await new Promise<void>((r) => this.q.push(r));
    this.n += 1;
    try {
      return await fn();
    } finally {
      this.n -= 1;
      this.q.shift()?.();
    }
  }
}

export async function withBackoff<T>(what: string, fn: () => Promise<T>, tries = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const msg = String((err as Error)?.message ?? err);
      const retry = /429|rate|too many|timeout|timed out|5\d\d|ECONN|socket|fetch failed|overloaded|empty/i.test(msg);
      if (!retry || i === tries - 1) break;
      const wait = Math.min(30_000, 1500 * 2 ** i) + Math.floor(Math.random() * 1000);
      process.stderr.write(`[backoff] ${what}: ${msg.slice(0, 120)}; retry in ${wait} ms\n`);
      await sleep(wait);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

let modelsPromise: Promise<any> | undefined;
/** The server's own model layer (gateway mode when TRUEFOUNDRY_API_KEY is set). */
export function models(): Promise<any> {
  modelsPromise ??= (async () => {
    const { createModelClient } = await import(`${REPO}/apps/server/src/models/index.ts`);
    const { createBus } = await import(`${REPO}/apps/server/src/bus.ts`);
    const bus = createBus({ onActivity: () => undefined });
    return createModelClient({ bus });
  })();
  return modelsPromise;
}

// ---------------------------------------------------------------------------
// Child servers
// ---------------------------------------------------------------------------

export async function portFree(port: number): Promise<boolean> {
  return new Promise((r) => {
    const s = createServer();
    s.once('error', () => r(false));
    s.listen(port, '127.0.0.1', () => s.close(() => r(true)));
  });
}

export interface Child {
  port: number;
  base: string;
  proc: ChildProcess;
  dataDir: string;
  stop(): Promise<void>;
}

/** tsx runs the server in a grandchild: signal the whole process group (children are spawned detached). */
function killGroup(p: ChildProcess, sig: NodeJS.Signals) {
  try {
    if (p.pid) process.kill(-p.pid, sig);
  } catch {
    try {
      p.kill(sig);
    } catch {
      /* gone */
    }
  }
}

/** Every child server still running; killed on exit/crash so no orphan servers are left behind. */
const LIVE = new Set<ChildProcess>();
let reaperInstalled = false;
function installReaper() {
  if (reaperInstalled) return;
  reaperInstalled = true;
  const reap = () => {
    for (const p of LIVE) killGroup(p, 'SIGKILL');
  };
  process.on('exit', reap);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => {
    reap();
    process.exit(130);
  });
  process.on('uncaughtException', (err) => {
    console.error(err);
    reap();
    process.exit(1);
  });
}

/** Start scripts/stress/server.mts on `port` with its own data dir (optionally restored from a snapshot). */
export async function startChild(opts: { port: number; dataDir: string; restore?: string; logFile: string }): Promise<Child> {
  if (opts.port === 8787 || opts.port === 3000) throw new Error('refusing to use a live port');
  for (let i = 0; i < 40 && !(await portFree(opts.port)); i++) await sleep(250);
  mkdirSync(opts.dataDir, { recursive: true });
  const log = createWriteStream(opts.logFile, { flags: 'a' });
  const env = { ...process.env, STRESS_PORT: String(opts.port), PACEPAY_DATA_DIR: opts.dataDir, PORT: String(opts.port) } as NodeJS.ProcessEnv;
  if (opts.restore) env.STRESS_RESTORE = opts.restore;
  else delete env.STRESS_RESTORE;
  const proc = spawn(`${REPO}/node_modules/.bin/tsx`, [`${REPO}/scripts/stress/server.mts`], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  installReaper();
  LIVE.add(proc);
  proc.stdout!.pipe(log);
  proc.stderr!.pipe(log);
  const base = `http://127.0.0.1:${opts.port}`;
  const started = Date.now();
  let exited = false;
  proc.once('exit', () => {
    exited = true;
    LIVE.delete(proc);
  });
  for (;;) {
    if (exited) throw new Error(`stress server on ${opts.port} exited during boot (see ${opts.logFile})`);
    try {
      const r = await fetch(`${base}/__stress/idle`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > 120_000) {
      killGroup(proc, 'SIGKILL');
      throw new Error(`stress server on ${opts.port} did not boot in 120 s`);
    }
    await sleep(200);
  }
  return {
    port: opts.port,
    base,
    proc,
    dataDir: opts.dataDir,
    async stop() {
      if (exited) return;
      killGroup(proc, 'SIGTERM');
      for (let i = 0; i < 30 && !exited; i++) await sleep(100);
      if (!exited) killGroup(proc, 'SIGKILL');
      for (let i = 0; i < 20 && !exited; i++) await sleep(100);
      log.end();
    },
  };
}

export function apiFor(base: string) {
  return async function api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const t = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${t.slice(0, 300)}`);
    return t ? JSON.parse(t) : undefined;
  };
}

export function ensureDir(d: string): string {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

/**
 * The fee one line settles on (whole dollars), or undefined. Positional: the LAST amount stated wins,
 * except an un-negated waiver ("I'll waive the $35 fee", "no fee") which means 0.
 */
export function feeOf(text: string): number | undefined {
  // spelled-out digits ("one-five", "one five" -> "1-5") read as one number (15), not a $5 fee;
  // cents ("21 dollars and 60 cents", "twenty-one sixty fee") read as 21.6
  const t = digitizeWords(text.replace(/,(?=\d{3})/g, ''))
    .replace(/\b\d(?:[ -]\d\b)+/g, (m) => m.replace(/[ -]/g, ''))
    .replace(/\b(\d{1,3}) dollars? and (\d{1,2}) cents?\b/gi, (_m, d, c) => `$${d}.${String(c).padStart(2, '0')}`)
    .replace(/\b([1-9]\d{1,2})[ -](\d{2})\b(?=\s*(?:fee|total|dollars?|in fees|charge))/gi, (_m, d, c) => `$${d}.${c}`);
  // Events in order: un-negated waivers count 0, amounts their value; the LAST mention wins
  // ("no fee... oh wait, $15" is 15; "I'll waive the $35 fee" is 0).
  const ev: { at: number; v: number }[] = [];
  const waive = /\b(waiv(e|ed|ing)|no (fee|charge)|without (a |any )?(fee|charge)|fee[- ]free|free of charge|no[- ]cost|at no cost)\b/gi;
  const neg = /\b(can'?t|cannot|won'?t|not able to|unable to|no way|not going to|isn'?t|is not|there'?s no way)\b[^.?!]{0,30}$/i;
  let w: RegExpExecArray | null;
  // "no fee isn't an option" / "there's no option to move it with no fee" deny a waiver
  const noOption = (at: number, len: number) =>
    /^\s*(isn['’]?t|is not|is never|wouldn['’]?t be|won['’]?t be|not)\s+(an option|possible|available)/i.test(t.slice(at + len, at + len + 30)) ||
    /\b(no option|not an option|not possible|can['’]?t|cannot|unable|no way)\b[^.?!]{0,30}$/i.test(t.slice(Math.max(0, at - 45), at));
  while ((w = waive.exec(t)))
    if (!(/^waiv/i.test(w[0]) && neg.test(t.slice(Math.max(0, w.index - 40), w.index))) && !(/^(no|without)/i.test(w[0]) && noOption(w.index, w[0].length)))
      ev.push({ at: w.index, v: 0 });
  const re = /\$\s?(\d{1,4}(?:\.\d{2})?)|\b(\d{1,4}(?:\.\d{2})?)\s?(?:dollars?|bucks|usd)\b|\b(?:fee|charge)\s(?:of|is|would be|will be|is gonna be|of about|of like)?\s?(\d{1,4})\b|\b(\d{1,3})[\s-](?:dollar[\s-])?(?:fee|charge)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const v = Number(m[1] ?? m[2] ?? m[3] ?? m[4]);
    if (!Number.isFinite(v)) continue;
    // $400 is the car payment itself and $420 a total, not fees (unless literally called a fee)
    if (v >= 300 && !/^\s?(?:-?dollars?)?[\s-]*(fee|charge)/i.test(t.slice(m.index + m[0].length))) continue;
    // "waive the $35 fee": the amount being waived (unless "can't waive the $35 fee")
    const before = t.slice(Math.max(0, m.index - 30), m.index);
    const waivedHere = /\bwaiv(e|ed|ing)\b[^.?!$\d,;]{0,20}$/i.test(before) && !neg.test(t.slice(Math.max(0, m.index - 70), m.index).replace(/waiv[\s\S]*$/i, ''));
    ev.push({ at: m.index, v: waivedHere ? 0 : v });
  }
  ev.sort((x, y) => x.at - y.at);
  return ev.length ? ev[ev.length - 1]!.v : undefined;
}
/** The day (of November 2026) one line settles on: the last explicit date, else a weekday name. */
export function dayOf(text: string): number | undefined {
  const d = daysIn(text);
  return d.length ? d[d.length - 1] : undefined;
}
