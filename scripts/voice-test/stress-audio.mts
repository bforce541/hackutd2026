/**
 * AUDIO-level call stress. Test tooling only: never dials, never texts, never touches the live server
 * (:8787), the live voice worker ("pacepay-voice"), the dashboard (:3000) or the text simulator ports.
 *
 * Real audio over real LiveKit rooms, ~6 calls at a time:
 *  - Per slot: a TEST voice worker (apps/voice/src/agent.ts, PACEPAY_VOICE_AGENT_NAME=pacepay-voice-stress-<n>),
 *    a tiny recording proxy between that worker and the slot's throwaway server (so every decide/approval
 *    answer, brief and transcript event is logged with its time), and per call a fresh throwaway server
 *    (scripts/stress/server.mts: console messaging, own port and data dir, LiveKit/Photon env removed,
 *    fake dialer) restored from a snapshot of the real flow at the calling step.
 *  - The synthetic lender joins as "counterparty" and speaks with OpenAI TTS (voices ash/coral/sage/verse,
 *    paced differently per call). Its words come from Nemotron Super playing a persona from
 *    scripts/stress/personas/*.json, reacting to the lines PacePay actually posted to the call transcript.
 *    Realism: "uh"s, mid-sentence pauses, talking over PacePay, long silences, a hang-up mid-line.
 *  - Yoshua's approval texts go through the server's text path (/api/demo/customer-says).
 * Measured per call: improvised lines (PacePay audio not from decide/approval/hold/filler/greeting),
 * duplicates, latency per turn (p50/p90), dead air > 3 s, cut-offs, meaning-changing transcription errors,
 * safety-contract issues (scripts/stress/grade.mts rules + judge) and whether the call ended cleanly.
 *
 * Run from the repo root:
 *   npx @dotenvx/dotenvx run --convention=nextjs -q -- apps/server/node_modules/.bin/tsx \
 *     scripts/voice-test/stress-audio.mts [--n 40] [--concurrency 6] [--per-cat 5] [--filter cat|id,...] \
 *     [--base 7610] [--out scripts/voice-test/out/<stamp>] [--no-judge] [--no-audio]
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  REPO, Semaphore, apiFor, digitizeWords, models, portFree, rng, seedOf, sleep, startChild, termsIn, withBackoff,
  type CallLine, type Persona, type RunResult, type Source, type TextMsg,
} from '../stress/lib.mts';

const VOICE = join(REPO, 'apps/voice');
function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const N = Number(arg('n', '40'));
const PER_CAT = Number(arg('per-cat', '5'));
const CONC = Math.max(1, Number(arg('concurrency', '6')));
const BASE = Number(arg('base', '7610'));
const OUT = resolve(REPO, arg('out', `scripts/voice-test/out/${stamp}`)!);
const NO_JUDGE = arg('no-judge') === 'true';
const SAVE_AUDIO = arg('no-audio') !== 'true';
const FILTER = arg('filter');
const CATS = (arg('cats', 'happy,offers,terms,asr_chaos,hostile,transfer_hold,ivr_voicemail,social') as string).split(',');
const MAX_CALL_MS = Number(arg('max-call-s', '420')) * 1000;
for (const p of [BASE, BASE + 10 * CONC + 10]) if ((p >= 8700 && p <= 9600) || p === 3000 || (p > 2900 && p < 3100)) throw new Error('port range overlaps a live/simulator port');
mkdirSync(join(OUT, 'calls'), { recursive: true });
mkdirSync(join(OUT, 'logs'), { recursive: true });
if (SAVE_AUDIO) mkdirSync(join(OUT, 'audio'), { recursive: true });
const SCRATCH = join(tmpdir(), `pacepay-stress-audio-${stamp}`);
mkdirSync(SCRATCH, { recursive: true });
const T_RUN = Date.now();
const log = (...a: unknown[]) => console.log(`[audio ${new Date().toISOString().slice(11, 19)}]`, ...a);

// LiveKit (rtc-node logs at debug unless NODE_ENV=production at import)
const pkg = (name: string) => pathToFileURL(join(realpathSync(join(VOICE, 'node_modules', name)), 'dist/index.js')).href;
const nodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
const rtc: any = await import(pkg('@livekit/rtc-node'));
if (nodeEnv === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = nodeEnv;
const lk: any = await import(pkg('livekit-server-sdk'));
const E = process.env;
const lkHttp = E.LIVEKIT_URL!.replace(/^wss:/, 'https:');
const dispatchClient = new lk.AgentDispatchClient(lkHttp, E.LIVEKIT_API_KEY, E.LIVEKIT_API_SECRET);
const roomsClient = new lk.RoomServiceClient(lkHttp, E.LIVEKIT_API_KEY, E.LIVEKIT_API_SECRET);

// The code's own lines (read-only import): fillers, hold updates, fallbacks.
const conductorMod: any = await import(`${REPO}/apps/voice/src/conductor.ts`);
const FILLER_TEXTS: string[] = (conductorMod.FILLERS ?? []).map((f: any) => f.text);
const HOLDS: string[] = conductorMod.holdUpdates?.('Yoshua') ?? [];
const CODE_LINES: string[] = [conductorMod.APPROVAL_FALLBACK_LINE, conductorMod.LOST_PLACE_LINE, ...(conductorMod.likelyLines?.('Yoshua') ?? [])].filter((x: unknown): x is string => typeof x === 'string');
const norm = (s: string) => digitizeWords(s.toLowerCase().replace(/[’']/g, '').replace(/\$/g, ' ')).replace(/[^a-z0-9]+/g, ' ').trim();

// ---------------------------------------------------------------------------------------------
// Personas: ~5 per category, limits reply affirmative (the snapshot is past the limits text)
// ---------------------------------------------------------------------------------------------
const AFFIRM = /^(y|yes|yeah|yep|ok|okay|sure|go|go ahead|do it|sounds good)\b/i;
function loadPersonas(): Persona[] {
  const dir = join(REPO, 'scripts/stress/personas');
  const by = new Map<string, Persona[]>();
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    for (const p of JSON.parse(readFileSync(join(dir, f), 'utf8')) as Persona[]) {
      if (!AFFIRM.test((p.yoshua?.limits_reply ?? 'yes').trim())) continue;
      by.set(p.category, [...(by.get(p.category) ?? []), p]);
    }
  }
  let out: Persona[] = [];
  if (FILTER) {
    const fs = FILTER.split(',');
    out = [...by.values()].flat().filter((p) => fs.some((x) => p.category === x || p.id.startsWith(x)));
  } else {
    // spread picks across each category's list (not just the first five)
    for (const c of CATS) {
      const l = by.get(c) ?? [];
      const step = Math.max(1, Math.floor(l.length / PER_CAT));
      for (let i = 0; i < PER_CAT && i * step < l.length; i++) out.push(l[i * step]!);
    }
  }
  // round-robin categories so concurrent calls are mixed
  const byc = new Map<string, Persona[]>();
  for (const p of out) byc.set(p.category, [...(byc.get(p.category) ?? []), p]);
  const rr: Persona[] = [];
  for (let i = 0; rr.length < out.length; i++) for (const l of byc.values()) if (l[i]) rr.push(l[i]!);
  return rr.slice(0, N);
}
const PERSONAS = loadPersonas();

// ---------------------------------------------------------------------------------------------
// Model helpers: Nemotron Super (no thinking, hedged) for the lender; OpenAI TTS / transcribe
// ---------------------------------------------------------------------------------------------
const superSem = new Semaphore(24);
async function superChat(messages: { role: string; content: string }[], maxTokens = 300, temperature = 0.7): Promise<string> {
  const base = E.TRUEFOUNDRY_BASE_URL;
  const key = E.TRUEFOUNDRY_API_KEY;
  const model = E.NEMOTRON_SUPER_MODEL;
  if (!base || !key || !model) {
    const out = await (await models()).chat({ role: 'orchestrator', messages, timeoutMs: 30_000, title: 'audio stress' });
    return String(out.text ?? '');
  }
  return superSem.run(() =>
    withBackoff('super', async () => {
      const ctls: AbortController[] = [];
      const one = async (): Promise<string> => {
        const ctl = new AbortController();
        ctls.push(ctl);
        const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, chat_template_kwargs: { enable_thinking: false } }),
          signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(25_000)]),
        });
        if (!res.ok) throw new Error(`super ${res.status}: ${(await res.text()).slice(0, 120)}`);
        const j: any = await res.json();
        let text = String(j.choices?.[0]?.message?.content ?? '');
        const th = text.lastIndexOf('</think>');
        if (th >= 0) text = text.slice(th + 8);
        text = text.replace(/<think>[\s\S]*$/i, '').trim();
        if (!text) throw new Error('empty reply');
        return text;
      };
      try {
        return await new Promise<string>((res, rej) => {
          let failed = 0;
          let started = 0;
          const timers: NodeJS.Timeout[] = [];
          const launch = () => {
            started += 1;
            one().then(
              (t) => {
                timers.forEach(clearTimeout);
                res(t);
              },
              (e) => {
                failed += 1;
                if (failed >= 3 || (failed === started && started >= 3)) {
                  timers.forEach(clearTimeout);
                  rej(e);
                } else if (failed === started) launch();
              },
            );
          };
          launch();
          for (const ms of [5000, 10000]) timers.push(setTimeout(() => started < 3 && launch(), ms));
        });
      } finally {
        ctls.forEach((c) => c.abort());
      }
    }, 4),
  );
}

const RATE = 24_000;
const FRAME = 480; // 20 ms
const ttsSem = new Semaphore(16);
interface VoiceProfile { voice: string; model: string; speed?: number; instructions?: string; label: string }
async function tts(text: string, vp: VoiceProfile): Promise<Int16Array> {
  return ttsSem.run(() =>
    withBackoff('tts', async () => {
      const body: Record<string, unknown> = { model: vp.model, voice: vp.voice, input: text, response_format: 'pcm' };
      if (vp.speed) body.speed = vp.speed;
      if (vp.instructions) body.instructions = vp.instructions;
      const r = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${E.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) throw new Error(`tts ${r.status} ${(await r.text()).slice(0, 100)}`);
      const b = new Uint8Array(await r.arrayBuffer());
      const pcm = new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.length & ~1)));
      // trim leading/trailing quiet so "the lender stopped" is the end of the words
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
      return pcm.slice(Math.max(0, s - W), Math.min(pcm.length, t + 2 * W));
    }, 5),
  );
}
function tone(ms: number, hz = 1000): Int16Array {
  const n = Math.round((RATE * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(9000 * Math.sin((2 * Math.PI * hz * i) / RATE));
  return out;
}
function wav(pcm: Int16Array, rate: number, ch = 1): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2 * ch, 28);
  h.writeUInt16LE(2 * ch, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const sttSem = new Semaphore(10);
async function transcribe(pcm: Int16Array): Promise<string> {
  return sttSem.run(() =>
    withBackoff('stt', async () => {
      const form = new FormData();
      form.append('file', new Blob([wav(pcm, RATE)], { type: 'audio/wav' }), 'pacepay.wav');
      form.append('model', 'gpt-4o-transcribe');
      form.append('language', 'en');
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${E.OPENAI_API_KEY}` }, body: form, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`stt ${r.status}`);
      return ((await r.json()) as { text: string }).text;
    }, 4),
  ).catch((e) => `[transcription failed: ${(e as Error).message}]`);
}

// ---------------------------------------------------------------------------------------------
// Snapshot of the real flow at the calling step (photo -> pick 1 -> OK limits), made once
// ---------------------------------------------------------------------------------------------
async function makeSnapshot(): Promise<string> {
  const port = BASE - 10;
  const dataDir = join(SCRATCH, 'setup-data');
  const child = await startChild({ port, dataDir, logFile: join(OUT, 'logs', '_setup.log') });
  const api = apiFor(child.base);
  const cur = () => api('GET', '/api/cases/current');
  const pending = async (kind: string) => ((await cur()).approvals ?? []).some((a: any) => a.kind === kind && a.status === 'pending');
  const until = async (what: string, ok: () => Promise<boolean>, ms = 300_000) => {
    const end = Date.now() + ms;
    while (!(await ok())) {
      if (Date.now() > end) throw new Error(`setup timed out waiting for ${what}`);
      await sleep(600);
    }
  };
  try {
    await api('POST', '/api/demo/bill-photo', { fixture: 'brake_quote' });
    let confirmed = false;
    await until('options', async () => {
      if (!confirmed && (await pending('bill_confirm'))) {
        confirmed = true;
        await api('POST', '/api/demo/customer-says', { text: 'yes' });
      }
      return pending('option_choice');
    });
    await api('POST', '/api/demo/customer-says', { text: '1' });
    await until('call limits', () => pending('call_limits'));
    await api('POST', '/api/demo/customer-says', { text: 'ok' });
    await until('the call row', async () => Object.values((await api('GET', '/__stress/state')).calls ?? {}).some((c: any) => c.direction === 'outbound' && c.status === 'dispatching'));
    await until('agent idle', async () => {
      const i = await api('GET', '/__stress/idle');
      return i.inflight === 0 && i.quietMs > 2500;
    }, 60_000);
    await api('POST', '/__stress/snapshot');
    await sleep(300);
  } finally {
    await child.stop();
  }
  const snap = join(SCRATCH, 'snapshot');
  cpSync(dataDir, snap, { recursive: true });
  return snap;
}

// ---------------------------------------------------------------------------------------------
// Slots: a recording proxy + a test worker each
// ---------------------------------------------------------------------------------------------
interface ProxyRec { t: number; path: string; kind: 'decide' | 'approval' | 'brief' | 'event' | 'other'; req?: any; res?: any; ms: number; status: number }
interface Slot {
  k: number;
  serverPort: number;
  proxyPort: number;
  workerPort: number;
  agent: string;
  target?: string; // the current call's server base
  recs: ProxyRec[];
  inflightDecide: number;
  worker?: ChildProcess;
  workerLines: { at: number; text: string }[];
  ready: boolean;
}
function startProxy(slot: Slot): Promise<void> {
  const srv = httpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const path = req.url ?? '/';
    const kind: ProxyRec['kind'] = /\/decide$/.test(path) ? 'decide' : /\/approval$/.test(path) ? 'approval' : /\/brief$/.test(path) ? 'brief' : /\/events$/.test(path) ? 'event' : 'other';
    if (!slot.target) {
      res.writeHead(503).end('no server');
      return;
    }
    const t = Date.now();
    if (kind === 'decide') slot.inflightDecide += 1;
    try {
      const r = await fetch(slot.target + path, { method: req.method, headers: req.headers['content-type'] ? { 'content-type': String(req.headers['content-type']) } : {}, body: body.length ? body : undefined });
      const out = Buffer.from(await r.arrayBuffer());
      let reqJ: any;
      let resJ: any;
      try {
        reqJ = body.length ? JSON.parse(body.toString()) : undefined;
      } catch {
        /* not json */
      }
      try {
        resJ = out.length ? JSON.parse(out.toString()) : undefined;
      } catch {
        /* not json */
      }
      slot.recs.push({ t, path, kind, req: reqJ, res: resJ, ms: Date.now() - t, status: r.status });
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' }).end(out);
    } catch (err) {
      slot.recs.push({ t, path, kind, ms: Date.now() - t, status: 599, res: { error: (err as Error).message } });
      res.writeHead(502).end((err as Error).message);
    } finally {
      if (kind === 'decide') slot.inflightDecide -= 1;
    }
  });
  return new Promise((r) => srv.listen(slot.proxyPort, '127.0.0.1', () => r()));
}
function startWorker(slot: Slot): Promise<void> {
  slot.ready = false;
  const env: NodeJS.ProcessEnv = { ...process.env, PACEPAY_VOICE_AGENT_NAME: slot.agent, PACEPAY_VOICE_PORT: String(slot.workerPort), SERVER_URL: `http://127.0.0.1:${slot.proxyPort}` };
  if (slot.agent === 'pacepay-voice' || !slot.agent.startsWith('pacepay-voice-stress-')) throw new Error('refusing the live agent name');
  const w = spawn(join(VOICE, 'node_modules/.bin/tsx'), [join(VOICE, 'src/agent.ts'), 'start'], { cwd: VOICE, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  slot.worker = w;
  const logFile = join(OUT, 'logs', `worker-${slot.k}.log`);
  let readyR!: () => void;
  const readyP = new Promise<void>((r) => (readyR = r));
  const on = (buf: Buffer) => {
    const s = buf.toString();
    try {
      writeFileSync(logFile, s, { flag: 'a' });
    } catch {
      /* ignore */
    }
    for (const l of s.split('\n')) {
      if (!l.trim()) continue;
      if (/registered worker/i.test(l)) {
        slot.ready = true;
        readyR();
      }
      if (l.includes('[voice]')) {
        const m = /^(\S+) \[voice\] (.*)$/.exec(l);
        const at = m ? Date.parse(m[1]!) : Date.now();
        slot.workerLines.push({ at: Number.isFinite(at) ? at : Date.now(), text: m ? m[2]! : l });
      }
    }
  };
  w.stdout!.on('data', on);
  w.stderr!.on('data', on);
  w.once('exit', (code) => {
    slot.ready = false;
    log(`worker ${slot.k} exited (${code})`);
  });
  return Promise.race([readyP, sleep(60_000).then(() => { throw new Error(`worker ${slot.k} did not register in 60 s`); })]);
}
function killWorker(slot: Slot) {
  const p = slot.worker;
  if (!p?.pid) return;
  try {
    process.kill(-p.pid, 'SIGINT');
  } catch {
    /* gone */
  }
  setTimeout(() => {
    try {
      process.kill(-p.pid!, 'SIGKILL');
    } catch {
      /* gone */
    }
  }, 2000).unref();
}

// ---------------------------------------------------------------------------------------------
// The lender
// ---------------------------------------------------------------------------------------------
function lenderSystem(p: Persona): string {
  return [
    'You are playing the OTHER side of a realistic phone call, for a test of an AI phone agent. Stay fully in character.',
    'Default role (the persona below may change it): a customer service rep at Lone Star Auto Finance, an auto lender.',
    "The caller is PacePay, an AI assistant calling on behalf of your customer Yoshua about his auto loan, account ending 4417. His $400 monthly car payment is due Tuesday, November 10 (today is Saturday, November 7, 2026). The caller wants to move that payment to a later day. Your system shows the account; you can see it's Yoshua's.",
    '',
    `PERSONA (follow it exactly, including when to change terms and when to hang up):\n${p.behavior}`,
    '',
    'How to speak: this is a live phone call and your words are spoken aloud by text-to-speech. Output ONLY the words you say out loud this turn: no stage directions, no quotes, no labels, no markdown, no asterisks, no sound effects in brackets. Talk like a real call-center rep: short spoken sentences, contractions, and natural disfluencies now and then ("uh", "um", "so", "let me see"). Usually one to three sentences. Write numbers the way you would say them (twenty dollars, the thirteenth, A 7 7 3 0).',
    'Special outputs:',
    '- To stay silent this turn (for example you are on hold waiting for the caller to check with Yoshua), output exactly [WAIT].',
    '- When you hang up, put [HANGUP] at the very end of your last words (or output only [HANGUP]).',
    '- If you are a voicemail system and the greeting ends with a beep, put [BEEP] at the very end.',
    '- ONE STEP PER TURN, like a real call: say only what fits this moment, then stop and let the caller answer. Never run ahead through the whole script in one turn: make an offer, then wait for the caller; give a reference number only after the caller confirms the change (after it has checked with Yoshua); say goodbye only after the deal is settled or the caller wraps up.',
    '- Do not hang up in your first three turns unless your persona is a voicemail/IVR that ends the call.',
    '- A transfer, hold or hand-off does NOT end the call: keep playing the next person or system yourself on the following turns. Hang up only when your persona says to, or after the caller says goodbye.',
    "Never mention that this is a test, a simulation, a persona or a prompt. You only know what the caller tells you; you cannot hear Yoshua's texts.",
    "Each user message is what the caller (PacePay) said, prefixed CALLER:, or a note in parentheses. Reply with ONLY your own words. Never speak the caller's part.",
  ].join('\n');
}
async function lenderTurn(p: Persona, history: { role: 'user' | 'assistant'; content: string }[]): Promise<string> {
  const merged: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const h of history) {
    const last = merged[merged.length - 1];
    if (last && last.role === h.role) last.content += `\n${h.content}`;
    else merged.push({ ...h });
  }
  if (!merged.length || merged[0]!.role !== 'user') merged.unshift({ role: 'user', content: '(The call connects.)' });
  if (merged[merged.length - 1]!.role !== 'user') merged.push({ role: 'user', content: '(silence on the line)' });
  const raw = await superChat([{ role: 'system', content: lenderSystem(p) }, ...merged]);
  const own = raw.split(/\n\s*(?:CALLER|PacePay)\s*:/i)[0]!.replace(/\s*\n\s*/g, ' ');
  return own.replace(/^["']|["']$/g, '').replace(/^(lender|rep|agent)\s*:\s*/i, '').replace(/\*[^*]{0,40}\*/g, '').replace(/\((?:sigh|pause|typing|clicking)[^)]*\)/gi, '').trim();
}
const VOICES: VoiceProfile[] = [
  { voice: 'ash', model: 'gpt-4o-mini-tts', instructions: 'A loan servicer on the phone: casual, a bit busy, natural pace.', label: 'ash/mini-tts' },
  { voice: 'coral', model: 'gpt-4o-mini-tts', instructions: 'A call-center rep on a phone line: friendly, speaks quickly, slightly clipped.', label: 'coral/mini-tts fast' },
  { voice: 'sage', model: 'gpt-4o-mini-tts', instructions: 'A tired call-center rep at the end of a long shift: slow, flat, with small hesitations.', label: 'sage/mini-tts slow' },
  { voice: 'verse', model: 'gpt-4o-mini-tts', instructions: 'A brisk rep on the phone: fast, matter-of-fact.', label: 'verse/mini-tts brisk' },
  { voice: 'ash', model: 'tts-1', speed: 1.2, label: 'ash/tts-1 x1.2' },
  { voice: 'coral', model: 'tts-1', speed: 1.3, label: 'coral/tts-1 x1.3' },
  { voice: 'sage', model: 'tts-1', speed: 0.85, label: 'sage/tts-1 x0.85' },
];
const INTERJECTIONS = ['Mm-hm.', 'Yeah, yeah.', 'Okay.', 'Sorry, go ahead.', 'Uh huh.', 'Wait, hold on.'];

// ---------------------------------------------------------------------------------------------
// One call
// ---------------------------------------------------------------------------------------------
interface LenderUtt { text: string; start: number; end: number; parts: { start: number; end: number }[]; pauses: { start: number; end: number }[]; kind: 'line' | 'interjection' | 'beep'; turn: number }
interface Seg { start: number; end: number; pcm: Int16Array[] }
interface AudioMetrics {
  voice: string;
  realism: { midPauses: number; uhs: number; barges: number; longSilences: number; hangupMid: boolean };
  pacepayLines: { t: number; kind: string; text: string; source: string }[];
  improvised: { text: string; why: string; t: number }[];
  unaccountedAudio: { t: number; heard: string; best: string; cover: number }[];
  blockedReplies: number;
  duplicates: string[];
  latencies: { after: string; anyMs: number | null; lineMs: number | null; t: number; filler: boolean }[];
  p50: number | null;
  p90: number | null;
  linep50: number | null;
  linep90: number | null;
  deadAir: { after: string; ms: number; t: number }[];
  holdGapsMs: number[];
  talkOverLender: { t: number; lender: string; pacepay: string }[];
  intoPause: { t: number; lender: string }[];
  selfCut: { t: number; line: string; heard: string }[];
  resumed: number;
  bargeOutcomes: { t: number; interjection: string; pacepayStoppedMs: number | null }[];
  asr: { said: string; heard: string; changed: boolean; why?: string }[];
  asrMeaningErrors: number;
  heardSegments: { t: number; dur: number; heard: string }[];
  endedCleanly: boolean;
  endNote: string;
}

async function runCall(slot: Slot, p: Persona, snap: string): Promise<RunResult & { audio?: AudioMetrics }> {
  const tStart = Date.now();
  const R = rng(seedOf(p.id + ':audio'));
  const res: RunResult & { audio?: AudioMetrics } = {
    persona: p, ok: false, call: [], texts: [], workerLog: [], decideLog: [], approvalPolls: [],
    timings: { setupMs: 0, callMs: 0, postMs: 0, totalMs: 0, lenderLlmMs: 0, decideMs: [] }, lender: 'super',
  };
  const vp = /ivr|voicemail/.test(p.id) && R() < 0.5 ? VOICES[3]! : VOICES[Math.floor(R() * VOICES.length)]!;
  // realism knobs for this call
  const pMidPause = 0.25 + R() * 0.15;
  const pUh = 0.2 + R() * 0.2;
  const pBarge = 0.12 + R() * 0.1;
  const pSilence = 0.08 + R() * 0.08;
  const hangupMidTurn = seedOf(p.id) % 9 === 0 ? 3 + Math.floor(R() * 3) : -1;
  const realism = { midPauses: 0, uhs: 0, barges: 0, longSilences: 0, hangupMid: false };

  const dataDir = join(SCRATCH, `data-${p.id}`);
  rmSync(dataDir, { recursive: true, force: true });
  for (let i = 0; i < 40 && !(await portFree(slot.serverPort)); i++) await sleep(250);
  const child = await startChild({ port: slot.serverPort, dataDir, restore: snap, logFile: join(OUT, 'logs', `${p.id}.server.log`) });
  const api = apiFor(child.base);
  slot.target = child.base;
  slot.recs = [];
  const wl0 = slot.workerLines.length;
  const room = `stressaudio-${slot.k}-${p.id}-${Date.now().toString(36)}`;
  const lroom = new rtc.Room();
  let stopYoshua = false;
  let gone = false;
  let endReason = '';
  let callId = '';
  const T0 = Date.now();
  const T = () => Date.now() - T0;
  // audio state
  const source = new rtc.AudioSource(RATE, 1, 100);
  type QItem = { pcm: Int16Array; part: boolean; onStart?: () => void; onEnd?: () => void };
  const queue: QItem[] = [];
  let lenderTalking = false;
  let pumpOn = true;
  const recL: { t: number; pcm: Int16Array }[] = [];
  const recP: { t: number; pcm: Int16Array }[] = [];
  const pump = (async () => {
    const silence = new Int16Array(FRAME);
    let curItem: QItem | undefined;
    let off = 0;
    while (pumpOn) {
      if (!curItem && queue.length) {
        curItem = queue.shift()!;
        off = 0;
        curItem.onStart?.();
      }
      let f = silence;
      if (curItem) {
        lenderTalking = curItem.part;
        f = new Int16Array(FRAME);
        f.set(curItem.pcm.subarray(off, off + FRAME));
        off += FRAME;
        if (off >= curItem.pcm.length) {
          const done = curItem;
          curItem = undefined;
          lenderTalking = false;
          setTimeout(() => done.onEnd?.(), 100); // what is still buffered in the source
        }
      }
      if (f !== silence && SAVE_AUDIO) recL.push({ t: Date.now(), pcm: f });
      try {
        await source.captureFrame(new rtc.AudioFrame(f, RATE, 1, FRAME));
      } catch {
        await sleep(20);
      }
    }
  })();
  const play = (items: { pcm: Int16Array; part: boolean }[]): Promise<{ start: number; end: number; parts: { start: number; end: number }[]; pauses: { start: number; end: number }[] }> =>
    new Promise((resolveP) => {
      const parts: { start: number; end: number }[] = [];
      const pauses: { start: number; end: number }[] = [];
      let start = 0;
      items.forEach((it, i) => {
        let s = 0;
        queue.push({
          ...it,
          onStart: () => {
            s = Date.now();
            if (!start) start = s;
          },
          onEnd: () => {
            (it.part ? parts : pauses).push({ start: s, end: Date.now() });
            if (i === items.length - 1) resolveP({ start, end: Date.now(), parts, pauses });
          },
        });
      });
    });
  // PacePay audio segmentation
  const QUIET_MS = 900;
  const segs: Seg[] = [];
  let cur: Seg | undefined;
  let lastLoud = 0;
  const onFrame = (frame: any) => {
    const d: Int16Array = frame.data;
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += d[i]! * d[i]!;
    const rms = Math.sqrt(sum / Math.max(1, d.length));
    const now = Date.now();
    if (SAVE_AUDIO && rms > 50) recP.push({ t: now, pcm: new Int16Array(d) });
    if (rms > 300) {
      lastLoud = now;
      if (!cur) cur = { start: now, end: now, pcm: [] };
    }
    if (cur) {
      cur.pcm.push(new Int16Array(d));
      if (now - lastLoud > QUIET_MS) {
        cur.end = lastLoud;
        segs.push(cur);
        cur = undefined;
      }
    }
  };
  const pacepaySpeaking = () => !!cur && Date.now() - lastLoud < 300;
  const lastOnsetAfter = (t: number) => [...segs, ...(cur ? [cur] : [])].find((s) => s.start > t)?.start;
  lroom.on(rtc.RoomEvent.TrackSubscribed, (track: any) => {
    if (track.kind !== rtc.TrackKind.KIND_AUDIO) return;
    void (async () => {
      const stream = new rtc.AudioStream(track, { sampleRate: RATE, numChannels: 1 });
      for await (const f of stream) onFrame(f);
    })();
  });
  const dtmfHeard: { t: number; digit: string }[] = [];
  lroom.on(rtc.RoomEvent.DtmfReceived, (_code: number, digit: string) => dtmfHeard.push({ t: T(), digit }));
  lroom.on(rtc.RoomEvent.Disconnected, () => {
    if (!gone) {
      gone = true;
      endReason ||= 'pacepay_hangup';
    }
  });

  // live transcript from the proxy (the worker posts PacePay lines as they start playing)
  const ppPosted = () =>
    slot.recs
      .filter((r) => r.kind === 'event' && r.req?.type === 'transcript' && r.req?.speaker === 'pacepay')
      .map((r) => ({ t: r.t, text: String(r.req.text) }));
  const heardPosted = () =>
    slot.recs
      .filter((r) => r.kind === 'event' && r.req?.type === 'transcript' && r.req?.speaker === 'counterparty')
      .map((r) => ({ t: r.t, text: String(r.req.text) }));
  let approvalPending = false;
  const lenderUtts: LenderUtt[] = [];
  const latSamples: { stop: number; after: string }[] = [];
  const bargeOutcomes: AudioMetrics['bargeOutcomes'] = [];

  try {
    // the restored call row
    const st0 = await api('GET', '/__stress/state');
    const callRow: any = Object.values(st0.calls).find((c: any) => c.direction === 'outbound' && c.status === 'dispatching');
    if (!callRow) throw new Error('no dispatching call in the restored state');
    callId = callRow.id;
    const negId: string = callRow.negotiationId;
    res.callPlan = st0.negotiations[negId]?.callPlan;
    res.callStartAt = new Date().toISOString();
    res.acceptedChangesBefore = st0.acceptedChanges;
    res.textsBefore = (st0.thread ?? []).map((m: any) => ({ dir: m.direction, text: m.text ?? '[image]', at: m.at }));
    const preThread = (st0.thread ?? []).length;
    res.timings.setupMs = Date.now() - tStart;

    // Yoshua answers each deal approval by text after the persona's delay
    const yo = p.yoshua ?? {};
    const reply = yo.approval_reply ?? 'yes';
    const delay = Math.max(0, Number(yo.approval_delay_s ?? 6)) * 1000;
    const seen = new Set<string>();
    const yoshua = (async () => {
      while (!stopYoshua) {
        try {
          const c = await api('GET', '/api/cases/current');
          approvalPending = (c.approvals ?? []).some((a: any) => a.kind === 'deal' && a.status === 'pending');
          for (const a of c.approvals ?? []) {
            if (a.kind !== 'deal' || a.status !== 'pending' || seen.has(a.id)) continue;
            seen.add(a.id);
            if (reply === 'silent') continue;
            const text = reply.startsWith('text:') ? reply.slice(5) : reply;
            void (async () => {
              await sleep(delay);
              if (stopYoshua) return;
              res.texts.push({ dir: 'in', text, at: new Date().toISOString(), t: T(), approvalReply: true });
              await api('POST', '/api/demo/customer-says', { text }).catch((e) => res.workerLog!.push(`yoshua text failed: ${e.message}`));
            })();
          }
        } catch {
          /* busy */
        }
        await sleep(600);
      }
    })();

    // dispatch the test worker into a unique room, then join as the lender ("answered")
    await dispatchClient.createDispatch(room, slot.agent, { metadata: JSON.stringify({ callId }) });
    const at = new lk.AccessToken(E.LIVEKIT_API_KEY, E.LIVEKIT_API_SECRET, { identity: 'counterparty' });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
    await lroom.connect(E.LIVEKIT_URL, await at.toJwt(), { autoSubscribe: true, dynacast: false });
    const track = rtc.LocalAudioTrack.createAudioTrack('mic', source);
    const opts = new rtc.TrackPublishOptions();
    opts.source = rtc.TrackSource.SOURCE_MICROPHONE;
    await lroom.localParticipant.publishTrack(track, opts);

    // pre-synth interjections
    const interj = INTERJECTIONS.filter(() => R() < 0.5).slice(0, 3);
    if (!interj.length) interj.push('Mm-hm.');
    const interjAudio = new Map<string, Int16Array>();
    void Promise.all(interj.map(async (t) => interjAudio.set(t, await tts(t, vp).catch(() => new Int16Array(0)))));

    /** Wait until PacePay has finished what it is saying in response to whatever came before `since`. */
    const waitPacePayDone = async (since: number, maxMs: number): Promise<'done' | 'silent' | 'gone' | 'timeout'> => {
      const end = Date.now() + maxMs;
      const n0 = ppPosted().filter((l) => l.t < since).length;
      for (;;) {
        if (gone) return 'gone';
        const fresh = ppPosted().slice(n0);
        const quiet = !pacepaySpeaking() && Date.now() - lastLoud >= 800;
        if (fresh.length) {
          const lastPost = fresh[fresh.length - 1]!.t;
          const heardIt = segs.some((s) => s.end > lastPost - 200) || (!!cur && cur.start < Date.now());
          if (heardIt && quiet && slot.inflightDecide === 0 && Date.now() - lastPost > 900) return 'done';
        } else if (slot.inflightDecide === 0 && quiet && Date.now() - since > (approvalPending ? 25_000 : 6_500)) return 'silent';
        if (Date.now() > end) return 'timeout';
        await sleep(100);
      }
    };

    // the greeting
    const g = await waitPacePayDone(T0, 40_000);
    if (g !== 'done') throw new Error(`no greeting heard (${g})`);
    let shown = 0;
    const history: { role: 'user' | 'assistant'; content: string }[] = [];
    const showNew = () => {
      const pp = ppPosted();
      for (; shown < pp.length; shown++) {
        const tx = pp[shown]!.text;
        history.push({ role: 'user', content: /^\(pressed/.test(tx) ? `(The caller pressed keypad keys: ${tx.replace(/[()]/g, '')})` : `CALLER: ${tx}` });
      }
    };
    let turn = 0;
    let waits = 0;
    const maxTurns = Math.max(4, Math.min(30, Number(p.max_turns ?? 16)));
    while (!gone) {
      if (turn >= maxTurns || T() > MAX_CALL_MS) {
        endReason = turn >= maxTurns ? 'max_turns' : 'max_time';
        break;
      }
      showNew();
      const holding = approvalPending;
      if (holding) history.push({ role: 'user', content: '(You are on hold while the caller checks with Yoshua. Output [WAIT] to keep waiting silently, or say something.)' });
      const t0 = Date.now();
      let raw: string;
      try {
        raw = await lenderTurn(p, history);
      } catch (err) {
        res.error = `lender model: ${(err as Error).message}`;
        endReason = 'error';
        break;
      }
      res.timings.lenderLlmMs += Date.now() - t0;
      if (holding) history.pop();
      if (gone) break;
      const hang = /\[HANGUP\]/i.test(raw);
      const beep = /\[BEEP\]/i.test(raw);
      let said = raw.replace(/\[HANGUP\]|\[WAIT\]|\[BEEP\]/gi, '').trim();
      if (!said && !hang && !beep) {
        waits += 1;
        const before = ppPosted().length;
        const until = Date.now() + (holding || approvalPending ? 100_000 : 7_000);
        while (Date.now() < until && !gone && ppPosted().length === before) await sleep(200);
        if (!gone && ppPosted().length === before) history.push({ role: 'user', content: '(a few seconds of silence)' });
        else if (!gone) await waitPacePayDone(Date.now() - 2000, 30_000);
        if (waits > 12) {
          endReason = 'lender_waited_out';
          break;
        }
        continue;
      }
      // a long silence before answering (abandoned if PacePay speaks up meanwhile)
      if (turn >= 1 && said && !hang && R() < pSilence) {
        realism.longSilences += 1;
        const before = ppPosted().length;
        const until = Date.now() + 4000 + R() * 3500;
        while (Date.now() < until && !gone && ppPosted().length === before) await sleep(100);
        if (gone) break;
        if (ppPosted().length > before) {
          await waitPacePayDone(Date.now() - 1500, 30_000);
          continue; // PacePay checked in: answer what it said instead
        }
      }
      if (said && !/^(uh|um|so|okay|ok|yeah|mm)\b/i.test(said) && R() < pUh) {
        said = `${['Uh,', 'Um,', 'Uh, so,', 'Okay, um,'][Math.floor(R() * 4)]} ${said}`;
        realism.uhs += 1;
      }
      turn += 1;
      history.push({ role: 'assistant', content: said || (beep ? '(beep)' : '(hangs up)') });
      // audio: maybe split with a mid-sentence pause
      const items: { pcm: Int16Array; part: boolean }[] = [];
      const words = said.split(/\s+/).filter(Boolean);
      let split = -1;
      if (words.length >= 8 && R() < pMidPause) {
        const comma = words.findIndex((w, i) => i >= 2 && i <= words.length - 3 && /,$/.test(w));
        split = comma >= 0 ? comma + 1 : Math.floor(words.length / 2);
      }
      if (said) {
        if (split > 0) {
          realism.midPauses += 1;
          const [a, b] = await Promise.all([tts(words.slice(0, split).join(' '), vp), tts(words.slice(split).join(' '), vp)]);
          items.push({ pcm: a, part: true }, { pcm: new Int16Array(Math.round(RATE * (0.9 + R() * 1.3))), part: false }, { pcm: b, part: true });
        } else items.push({ pcm: await tts(said, vp), part: true });
      }
      if (beep) items.push({ pcm: new Int16Array(Math.round(RATE * 0.3)), part: false }, { pcm: tone(450), part: true });
      if (gone) break;
      const played = await play(items);
      lenderUtts.push({ text: said || '(beep)', start: played.start, end: played.end, parts: played.parts, pauses: played.pauses, kind: said ? 'line' : 'beep', turn });
      latSamples.push({ stop: played.end, after: said || '(beep)' });
      if (hang) {
        await sleep(400);
        endReason = 'lender_hangup';
        break;
      }
      // plan: hang up mid-line / barge in on PacePay's answer
      if (turn === hangupMidTurn) {
        const n0 = ppPosted().length;
        const until = Date.now() + 20_000;
        while (Date.now() < until && !gone && !(ppPosted().length > n0 && pacepaySpeaking())) await sleep(50);
        if (!gone && ppPosted().length > n0) {
          await sleep(900 + R() * 800);
          realism.hangupMid = true;
          endReason = 'lender_hangup_midline';
          lenderUtts.push({ text: '(hangs up mid-line)', start: Date.now(), end: Date.now(), parts: [], pauses: [], kind: 'interjection', turn });
          break;
        }
      } else if (turn >= 2 && R() < pBarge && interj.some((t) => (interjAudio.get(t)?.length ?? 0) > 0)) {
        const n0 = ppPosted().length;
        const until = Date.now() + 15_000;
        while (Date.now() < until && !gone && !(ppPosted().length > n0 && pacepaySpeaking())) await sleep(50);
        const onset = cur?.start;
        if (!gone && ppPosted().length > n0 && onset) {
          const lineText = ppPosted()[ppPosted().length - 1]!.text;
          // only barge into lines long enough to talk over
          if (lineText.split(/\s+/).length >= 9) {
            await sleep(Math.max(0, onset + 700 + R() * 900 - Date.now()));
            if (!gone && pacepaySpeaking()) {
              const pick = interj.filter((t) => (interjAudio.get(t)?.length ?? 0) > 0);
              const ij = pick[Math.floor(R() * pick.length)]!;
              realism.barges += 1;
              showNew();
              history.push({ role: 'user', content: '(You cut in while the caller was still saying the line above.)' });
              history.push({ role: 'assistant', content: ij });
              const pl = await play([{ pcm: interjAudio.get(ij)!, part: true }]);
              lenderUtts.push({ text: ij, start: pl.start, end: pl.end, parts: pl.parts, pauses: [], kind: 'interjection', turn });
              latSamples.push({ stop: pl.end, after: ij });
              const stopAt = (() => {
                // when did PacePay's audio stop after we started talking?
                const s = [...segs, ...(cur ? [cur] : [])].find((x) => x.start <= pl.start && x.end >= pl.start - 50);
                return s && s.end < pl.end + 2000 ? s.end - pl.start : null;
              })();
              bargeOutcomes.push({ t: pl.start - T0, interjection: ij, pacepayStoppedMs: stopAt });
            }
          }
        }
      }
      const w = await waitPacePayDone(played.end, approvalPending ? 110_000 : 45_000);
      if (w === 'gone') break;
      if (w === 'silent') history.push({ role: 'user', content: '(silence on the line)' });
      if (w === 'timeout') history.push({ role: 'user', content: '(a long silence)' });
    }
    // end of the lender side
    res.timings.callMs = Date.now() - T0;
    if (!gone) {
      // lender hangs up (or the harness ends the call)
      gone = true;
      await lroom.disconnect().catch(() => undefined);
    }
    res.endReason = endReason || 'pacepay_hangup';
    await sleep(1200);
    await roomsClient.deleteRoom(room).catch(() => undefined);

    // after the call: wait for the texts to Yoshua (Done / no deal / follow-up)
    const tPost = Date.now();
    const endBy = Date.now() + 120_000;
    let quietSince = Date.now();
    let lastLen = -1;
    let st: any;
    for (;;) {
      st = await api('GET', '/__stress/state');
      const c = st.cases?.[st.currentCaseId];
      const idle = st.__inflight === 0;
      const len = (st.thread ?? []).length;
      if (len !== lastLen) {
        lastLen = len;
        quietSince = Date.now();
      }
      const outAfter = (st.thread ?? []).slice(preThread).some((m: any) => m.direction === 'out' && Date.parse(m.at) >= tPost - 20_000);
      const pend = Object.values(st.approvals ?? {}).some((a: any) => a.status === 'pending' && a.kind === 'deal');
      if (idle && !pend && (c?.state === 'DONE' || outAfter) && Date.now() - quietSince > 5000) break;
      if (idle && !pend && !outAfter && Date.now() - tPost > 45_000 && Date.now() - quietSince > 8000) break;
      if (Date.now() > endBy) {
        res.workerLog!.push('post-call wait timed out (120 s)');
        break;
      }
      await sleep(700);
    }
    stopYoshua = true;
    await yoshua;
    res.timings.postMs = Date.now() - tPost;
    const outTexts: TextMsg[] = (st.thread ?? []).slice(preThread).map((m: any) => ({ dir: m.direction, text: m.text ?? '[image]', at: m.at, t: Date.parse(m.at) - T0 }));
    const harnessIn = res.texts;
    res.texts = outTexts.map((m) => {
      const h = m.dir === 'in' ? harnessIn.find((x) => x.text === m.text) : undefined;
      return h ? { ...m, approvalReply: h.approvalReply } : m;
    });
    res.negotiation = st.negotiations[negId];
    res.approvals = Object.values(st.approvals ?? {}).filter((a: any) => a.kind === 'deal' && (a.negotiationId === negId || a.callId === callId));
    res.acceptedChanges = st.acceptedChanges;
    res.caseState = st.cases?.[st.currentCaseId]?.state;
    res.callRow = st.calls[callId];
    res.ok = true;
  } catch (err) {
    res.error = (err as Error).stack ?? String(err);
    res.endReason ??= 'error';
  } finally {
    stopYoshua = true;
    if (!gone) {
      gone = true;
      await lroom.disconnect().catch(() => undefined);
    }
    pumpOn = false;
    await pump.catch(() => undefined);
    if (cur) {
      cur.end = lastLoud;
      segs.push(cur);
      cur = undefined;
    }
    await roomsClient.deleteRoom(room).catch(() => undefined);
    slot.target = undefined;
    await child.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------------------------------
  // Analysis
  // ---------------------------------------------------------------------------------------------
  const wlines = slot.workerLines.slice(wl0);
  res.workerLog = [...(res.workerLog ?? []), ...wlines.map((l) => `${new Date(l.at).toISOString().slice(11, 23)} ${l.text}`)];
  const recs = slot.recs;
  const decideRecs = recs.filter((r) => r.kind === 'decide');
  res.decideLog = decideRecs.map((r) => ({ utterance: r.req?.utterance ?? '', say: r.res?.say ?? '', next: r.res?.next ?? '', state: r.res?.state, ms: r.ms, t: r.t - T0, ...(r.res?.dtmf ? { dtmf: r.res.dtmf } : {}) }));
  res.timings.decideMs = decideRecs.map((r) => r.ms);
  res.approvalPolls = recs.filter((r) => r.kind === 'approval' && r.res?.status && r.res.status !== 'pending').map((r) => ({ status: r.res.status, say: r.res.say, next: r.res.next, t: r.t - T0 }));
  const brief = recs.find((r) => r.kind === 'brief')?.res;
  const decideSays = new Set(decideRecs.map((r) => norm(r.res?.say ?? '')).filter(Boolean));
  const approvalSays = new Set(recs.filter((r) => r.kind === 'approval').map((r) => norm(r.res?.say ?? '')).filter(Boolean));
  const prepared = new Set(recs.flatMap((r) => (Array.isArray(r.res?.prepare) ? r.res.prepare : [])).map((x: string) => norm(x)));
  const holds = new Set(HOLDS.map(norm));
  const fillers = new Set(FILLER_TEXTS.map(norm));
  const code = new Set(CODE_LINES.map(norm));
  const sourceOf = (text: string, kind: string): Source | 'code' | 'prepared' => {
    const n = norm(text);
    if (kind === 'greeting' && brief?.greeting && norm(brief.greeting) === n) return 'greeting';
    if (kind === 'filler' && fillers.has(n)) return 'filler';
    if (decideSays.has(n)) return 'decide';
    if (approvalSays.has(n)) return 'approval';
    if (holds.has(n)) return 'hold_update';
    if (code.has(n)) return 'code';
    if (prepared.has(n)) return 'prepared';
    return 'worker';
  };
  const said = wlines
    .map((l) => ({ at: l.at, m: /^say \((\w+)\): "(.*)"$/.exec(l.text) }))
    .filter((x): x is { at: number; m: RegExpExecArray } => !!x.m)
    .map((x) => ({ t: x.at, kind: x.m[1]!, text: x.m[2]! }));
  const ppLines = said.map((s) => ({ ...s, source: sourceOf(s.text, s.kind) as string }));
  const improvised = ppLines.filter((s) => s.source === 'worker' || s.source === 'prepared').map((s) => ({ text: s.text, why: s.source === 'prepared' ? 'only in a prepare list, never returned as say' : 'not from decide/approval/hold/filler/greeting', t: s.t - T0 }));
  const blockedReplies = wlines.filter((l) => /blocked a reply/.test(l.text)).length;
  const resumed = wlines.filter((l) => /resuming a line cut off/.test(l.text)).length;
  // the call as graded: PacePay lines (+dtmf) and lender lines with what PacePay heard
  const heard = heardPosted();
  const callLines: CallLine[] = [];
  for (const s of ppLines) callLines.push({ who: 'pacepay', text: s.text, kind: s.kind, source: (['code', 'prepared'].includes(s.source) ? 'worker' : s.source) as Source, turn: 0, t: s.t - T0 });
  for (const d of res.decideLog ?? []) if ((d as any).dtmf) callLines.push({ who: 'pacepay', text: `[DTMF ${(d as any).dtmf}]`, kind: 'dtmf', source: 'decide', turn: 0, t: d.t });
  const asr: AudioMetrics['asr'] = [];
  lenderUtts.forEach((u, i) => {
    if (u.kind === 'beep' || u.text.startsWith('(hangs up')) return;
    const nextStart = lenderUtts[i + 1]?.start ?? Infinity;
    const h = heard.filter((x) => x.t >= u.start && x.t < nextStart + 0).map((x) => x.text);
    const hs = h.join(' / ');
    callLines.push({ who: 'lender', text: u.text, heard: hs || '(nothing transcribed)', turn: u.turn, t: u.start - T0 });
    asr.push({ said: u.text, heard: hs, changed: false });
  });
  callLines.sort((a, b) => a.t - b.t);
  res.call = callLines;

  // meaning-changing transcription errors: rules (terms/digits/negation) + Nemotron Super check
  const digits = (s: string) => (norm(s).match(/\b\d+\b/g) ?? []).join(' ');
  const neg = (s: string) => /\b(no|not|can't|cannot|won't|don't|isn't)\b/i.test(s);
  for (const a of asr) {
    if (!a.heard) {
      if (a.said.split(/\s+/).length >= 2) {
        a.changed = true;
        a.why = 'nothing transcribed';
      }
      continue;
    }
    const ts = termsIn(a.said);
    const th = termsIn(a.heard);
    if ((ts.fee !== undefined && th.fee !== ts.fee) || (ts.day !== undefined && th.day !== ts.day)) {
      a.changed = true;
      a.why = `terms ${JSON.stringify(ts)} heard as ${JSON.stringify(th)}`;
    } else if (digits(a.said) && digits(a.said) !== digits(a.heard)) {
      a.changed = true;
      a.why = `digits "${digits(a.said)}" heard as "${digits(a.heard)}"`;
    } else if (neg(a.said) !== neg(a.heard)) {
      a.changed = true;
      a.why = 'negation lost/added';
    }
  }
  const diffIdx = asr.map((a, i) => ({ a, i })).filter(({ a }) => a.heard && !a.changed && norm(a.said) !== norm(a.heard));
  if (diffIdx.length) {
    try {
      const prompt = diffIdx.map(({ a, i }) => `${i}. SAID: ${a.said}\n   HEARD: ${a.heard}`).join('\n');
      const out = await superChat(
        [
          { role: 'system', content: 'You check phone speech-to-text. For each pair, decide if HEARD changes the MEANING of SAID in a way that matters for a call about moving a loan payment (a different day, amount, fee, yes/no, reference number, name, or a request turned into something else). Ignore filler words, punctuation, digits vs words, small wording slips. Reply ONLY with JSON: {"changed":[{"i":<index>,"why":"<short>"}]}' },
          { role: 'user', content: prompt },
        ],
        400,
        0,
      );
      const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
      for (const c of j.changed ?? []) {
        const a = asr[Number(c.i)];
        if (a) {
          a.changed = true;
          a.why = `llm: ${String(c.why).slice(0, 120)}`;
        }
      }
    } catch {
      /* best effort */
    }
  }

  // PacePay audio, transcribed per segment, matched to the lines the worker spoke
  const heardSegments: AudioMetrics['heardSegments'] = [];
  const unaccounted: AudioMetrics['unaccountedAudio'] = [];
  const selfCut: AudioMetrics['selfCut'] = [];
  await Promise.all(
    segs.map(async (s) => {
      const pcm = new Int16Array(s.pcm.reduce((n, x) => n + x.length, 0));
      let o = 0;
      for (const x of s.pcm) {
        pcm.set(x, o);
        o += x.length;
      }
      if (pcm.length < RATE * 0.25) return;
      const h = await transcribe(pcm);
      heardSegments.push({ t: s.start - T0, dur: s.end - s.start, heard: h });
      const hw = norm(h).split(' ').filter(Boolean);
      if (!hw.length || /transcription failed/.test(h)) return;
      const cands = ppLines.filter((l) => l.t <= s.end + 500 && l.t >= s.start - 30_000);
      const vocab = new Set(cands.flatMap((l) => norm(l.text).split(' ')));
      const cover = hw.filter((w) => vocab.has(w) || /^(uh|um|mm|hmm|oh|ah)$/.test(w)).length / hw.length;
      if (hw.length >= 3 && cover < 0.6) {
        const best = cands.slice(-3).map((l) => l.text).join(' | ');
        unaccounted.push({ t: s.start - T0, heard: h, best, cover: Math.round(cover * 100) / 100 });
      }
    }),
  );
  heardSegments.sort((a, b) => a.t - b.t);
  // a non-filler line whose audio was cut short with no lender speech over it
  for (const l of ppLines.filter((x) => x.kind !== 'filler')) {
    const s = segs.find((x) => x.end >= l.t && x.start <= l.t + 4000);
    if (!s) continue;
    const hs = heardSegments.find((x) => x.t === s.start - T0);
    if (!hs) continue;
    const lw = norm(l.text).split(' ').filter(Boolean);
    const hset = new Set(norm(hs.heard).split(' '));
    const got = lw.filter((w) => hset.has(w)).length / Math.max(1, lw.length);
    const lenderOver = lenderUtts.some((u) => u.parts.some((pt) => pt.start < s.end + 300 && pt.end > s.start));
    if (got < 0.55 && !lenderOver && lw.length >= 5 && s.end - s.start < 400 * lw.length) selfCut.push({ t: s.start - T0, line: l.text, heard: hs.heard });
  }
  // talk-over and jumping into a mid-sentence pause
  const talkOver: AudioMetrics['talkOverLender'] = [];
  const intoPause: AudioMetrics['intoPause'] = [];
  for (const s of segs) {
    for (const u of lenderUtts) {
      if (u.kind === 'interjection') continue;
      if (u.start < s.start - 200 && u.end > s.start + 300 && u.parts.some((pt) => pt.start < s.start && pt.end > s.start + 150)) {
        const pp = ppLines.filter((l) => l.t <= s.start + 500).pop();
        talkOver.push({ t: s.start - T0, lender: u.text, pacepay: pp?.text ?? '' });
      }
      for (const pz of u.pauses) if (u.parts.length > 1 && s.start >= pz.start && s.start <= pz.end + 200) intoPause.push({ t: s.start - T0, lender: u.text });
    }
  }
  // latency: lender stops -> PacePay audio onset (any, incl. filler) / first non-filler line onset
  const latencies: AudioMetrics['latencies'] = [];
  const deadAir: AudioMetrics['deadAir'] = [];
  for (const [i, l] of latSamples.entries()) {
    const nextLender = latSamples[i + 1]?.stop ?? Infinity;
    const nextLenderStart = lenderUtts.find((u) => u.start > l.stop)?.start ?? Infinity;
    const limit = Math.min(nextLenderStart, l.stop + 30_000);
    const any = lastOnsetAfter(l.stop);
    const anyMs = any && any < limit ? any - l.stop : null;
    const line = ppLines.find((x) => x.kind !== 'filler' && x.t >= l.stop - 300 && x.t < limit);
    const lineOnset = line ? [...segs].find((s) => s.start >= line.t - 150 && s.start < line.t + 5000)?.start ?? (segs.find((s) => s.start <= line.t && s.end >= line.t) ? line.t : undefined) : undefined;
    const lineMs = lineOnset ? Math.max(0, lineOnset - l.stop) : null;
    const fillerFirst = !!ppLines.find((x) => x.kind === 'filler' && x.t >= l.stop - 300 && x.t < (line?.t ?? limit));
    latencies.push({ after: l.after, anyMs, lineMs, t: l.stop - T0, filler: fillerFirst });
    if (anyMs !== null && anyMs > 3000) deadAir.push({ after: l.after, ms: anyMs, t: l.stop - T0 });
    void nextLender;
  }
  const pct = (xs: number[], q: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]! : null;
  };
  const anyL = latencies.map((x) => x.anyMs).filter((x): x is number => x !== null);
  const lineL = latencies.map((x) => x.lineMs).filter((x): x is number => x !== null);
  // gaps in PacePay audio while it holds for Yoshua and the lender is silent
  const holdGapsMs: number[] = [];
  const approvalReq = (res.approvals ?? []).map((a: any) => ({ from: Date.parse(a.requestedAt), to: a.resolvedAt ? Date.parse(a.resolvedAt) : Infinity }));
  for (const w of approvalReq) {
    const inHold = segs.filter((s) => s.start >= w.from && s.start <= Math.min(w.to, T0 + (res.timings.callMs || 0) + 5000));
    let prev = w.from;
    for (const s of inHold) {
      const lenderBetween = lenderUtts.some((u) => u.start > prev && u.start < s.start);
      if (!lenderBetween) holdGapsMs.push(s.start - prev);
      prev = s.end;
    }
  }
  const dupCount = new Map<string, number>();
  for (const l of ppLines) if (l.kind !== 'filler') dupCount.set(norm(l.text), (dupCount.get(norm(l.text)) ?? 0) + 1);
  const duplicates = ppLines.filter((l, i) => l.kind !== 'filler' && ppLines.slice(0, i).some((q) => q.kind !== 'filler' && norm(q.text) === norm(l.text))).map((l) => l.text);
  // ended cleanly?
  const lastPP = ppLines.filter((l) => l.kind !== 'filler').pop();
  const finalText = (res.texts ?? []).filter((m) => m.dir === 'out' && (m.t ?? 0) > (res.timings.callMs ?? 0) - 30_000).pop();
  const pacepayEnded = res.endReason === 'pacepay_hangup';
  const lenderEnded = /^lender_hangup/.test(res.endReason ?? '');
  const callStatus = res.callRow?.status;
  const notes: string[] = [];
  if (!res.ok) notes.push('harness error');
  if (!(pacepayEnded || lenderEnded)) notes.push(`call did not end by a hang-up (${res.endReason})`);
  if (callStatus && !/ended|completed|done|failed/.test(callStatus)) notes.push(`call row status ${callStatus}`);
  if (!finalText) notes.push('no text to Yoshua after the call');
  if (pacepayEnded && lastPP && !/\b(bye|goodbye|thank|thanks|take care|have a (good|great|nice))\b/i.test(lastPP.text)) notes.push(`PacePay hung up after "${lastPP.text.slice(0, 80)}" (no goodbye)`);
  if (pacepayEnded && lastPP && lenderUtts.length && lenderUtts[lenderUtts.length - 1]!.end > (lastPP.t ?? 0) + 6000) notes.push('PacePay hung up long after its last line / while the lender was talking');
  res.audio = {
    voice: vp.label,
    realism,
    pacepayLines: ppLines.map((l) => ({ t: l.t - T0, kind: l.kind, text: l.text, source: l.source })),
    improvised,
    unaccountedAudio: unaccounted,
    blockedReplies,
    duplicates,
    latencies,
    p50: pct(anyL, 0.5),
    p90: pct(anyL, 0.9),
    linep50: pct(lineL, 0.5),
    linep90: pct(lineL, 0.9),
    deadAir,
    holdGapsMs,
    talkOverLender: talkOver,
    intoPause,
    selfCut,
    resumed,
    bargeOutcomes,
    asr,
    asrMeaningErrors: asr.filter((a) => a.changed).length,
    heardSegments,
    endedCleanly: notes.length === 0,
    endNote: notes.join('; '),
  };
  if (dtmfHeard.length) res.workerLog!.push(`lender heard DTMF: ${dtmfHeard.map((d) => d.digit).join('')}`);
  // the call recording: stereo 8 kHz, lender left, PacePay right
  if (SAVE_AUDIO && (recL.length || recP.length)) {
    const endT = Math.max(...[...recL, ...recP].map((x) => x.t)) + 100;
    const n = Math.ceil(((endT - T0) / 1000) * 8000);
    const st = new Int16Array(n * 2);
    for (const [ch, rec] of [[0, recL], [1, recP]] as const)
      for (const fr of rec) {
        const base = Math.floor(((fr.t - T0) / 1000) * 8000);
        for (let j = 0; j < fr.pcm.length / 3; j++) {
          const idx = base + j;
          if (idx >= 0 && idx < n) st[idx * 2 + ch] = fr.pcm[j * 3]!;
        }
      }
    writeFileSync(join(OUT, 'audio', `${p.id}.wav`), wav(st, 8000, 2));
  }
  res.timings.totalMs = Date.now() - tStart;
  return res;
}

// ---------------------------------------------------------------------------------------------
// Grading: the text stress grader (rules + judge) plus the audio checks
// ---------------------------------------------------------------------------------------------
type AR = RunResult & { audio?: AudioMetrics };
function audioIssues(r: AR) {
  const a = r.audio;
  const out: { check: string; severity: 'critical' | 'high' | 'medium' | 'low'; detail: string; by: 'rule'; cause: string }[] = [];
  if (!a) return out;
  for (const x of a.improvised) out.push({ check: 'improvised_line', severity: 'critical', detail: `${(x.t / 1000).toFixed(1)}s "${x.text}" (${x.why})`, by: 'rule', cause: 'voice:improvised' });
  for (const x of a.unaccountedAudio) out.push({ check: 'unaccounted_audio', severity: 'high', detail: `${(x.t / 1000).toFixed(1)}s heard "${x.heard}" (cover ${x.cover}; near: ${x.best.slice(0, 120)})`, by: 'rule', cause: 'voice:audio-not-from-a-line' });
  if (a.blockedReplies) out.push({ check: 'blocked_reply', severity: 'medium', detail: `${a.blockedReplies} realtime reply(ies) blocked`, by: 'rule', cause: 'voice:blocked-reply' });
  for (const d of new Set(a.duplicates)) out.push({ check: 'duplicate_line', severity: 'medium', detail: `"${d}" spoken ${a.duplicates.filter((x) => x === d).length + 1}x`, by: 'rule', cause: 'voice:duplicate' });
  for (const d of a.deadAir) out.push({ check: 'dead_air', severity: d.ms > 6000 ? 'high' : 'medium', detail: `${(d.t / 1000).toFixed(1)}s ${d.ms} ms of dead air after "${d.after.slice(0, 80)}"`, by: 'rule', cause: 'voice:dead-air' });
  for (const t of a.talkOverLender) out.push({ check: 'talked_over_lender', severity: 'medium', detail: `${(t.t / 1000).toFixed(1)}s PacePay "${t.pacepay.slice(0, 60)}" over lender "${t.lender.slice(0, 60)}"`, by: 'rule', cause: 'voice:talk-over' });
  for (const t of a.intoPause) out.push({ check: 'answered_into_pause', severity: 'medium', detail: `${(t.t / 1000).toFixed(1)}s PacePay jumped into a mid-sentence pause of "${t.lender.slice(0, 80)}"`, by: 'rule', cause: 'voice:cut-off-lender' });
  for (const s of a.selfCut) out.push({ check: 'self_cut', severity: 'medium', detail: `${(s.t / 1000).toFixed(1)}s "${s.line.slice(0, 80)}" heard as "${s.heard.slice(0, 80)}"`, by: 'rule', cause: 'voice:cut-itself-off' });
  for (const x of a.asr.filter((q) => q.changed)) out.push({ check: 'asr_meaning', severity: 'low', detail: `said "${x.said.slice(0, 80)}" heard "${x.heard.slice(0, 80)}" (${x.why})`, by: 'rule', cause: 'asr:meaning-changed' });
  for (const g of a.holdGapsMs.filter((x) => x > 25_000)) out.push({ check: 'hold_silence', severity: 'medium', detail: `${(g / 1000).toFixed(0)} s of silence while holding for Yoshua`, by: 'rule', cause: 'voice:hold-silence' });
  if (!a.endedCleanly) out.push({ check: 'unclean_end', severity: /no text|harness/.test(a.endNote) ? 'high' : 'medium', detail: a.endNote, by: 'rule', cause: 'voice:end' });
  return out;
}

function audioReport(results: AR[]): string {
  const L: string[] = [];
  const ok = results.filter((r) => r.ok && r.audio);
  const all = ok.flatMap((r) => r.audio!.latencies.map((l) => l.anyMs).filter((x): x is number => x !== null));
  const lines = ok.flatMap((r) => r.audio!.latencies.map((l) => l.lineMs).filter((x): x is number => x !== null));
  const pct = (xs: number[], q: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]! : NaN;
  };
  const sum = (f: (r: AR) => number) => ok.reduce((n, r) => n + f(r), 0);
  const passN = results.filter((r) => r.grade?.pass).length;
  L.push(`# PacePay audio-level call stress (${new Date(T_RUN).toISOString()})`, '');
  L.push(`${results.length} calls, ${ok.length} ran without a harness error, concurrency ${CONC}. Pass = no critical/high issue (safety rules + judge + audio checks).`, '');
  L.push(`- **pass rate: ${passN}/${results.length} (${Math.round((100 * passN) / Math.max(1, results.length))}%)**`);
  L.push(`- improvised lines: ${sum((r) => r.audio!.improvised.length)} (calls: ${ok.filter((r) => r.audio!.improvised.length).length}); audio not matching any handed line: ${sum((r) => r.audio!.unaccountedAudio.length)}; blocked realtime replies: ${sum((r) => r.audio!.blockedReplies)}`);
  L.push(`- duplicate lines: ${sum((r) => r.audio!.duplicates.length)} (calls: ${ok.filter((r) => r.audio!.duplicates.length).length})`);
  L.push(`- latency lender-stops -> PacePay audio (any, incl. filler): p50 ${pct(all, 0.5)} ms, p90 ${pct(all, 0.9)} ms over ${all.length} turns; to the real line: p50 ${pct(lines, 0.5)} ms, p90 ${pct(lines, 0.9)} ms over ${lines.length}`);
  L.push(`- dead air > 3 s: ${sum((r) => r.audio!.deadAir.length)} turns in ${ok.filter((r) => r.audio!.deadAir.length).length} calls`);
  L.push(`- cut-offs: PacePay over the lender ${sum((r) => r.audio!.talkOverLender.length)}, into a mid-sentence pause ${sum((r) => r.audio!.intoPause.length)} (of ${sum((r) => r.audio!.realism.midPauses)} pauses), PacePay cut itself short ${sum((r) => r.audio!.selfCut.length)}, lines resumed ${sum((r) => r.audio!.resumed)}`);
  L.push(`- lender barge-ins: ${sum((r) => r.audio!.realism.barges)}; PacePay stopped within 1 s in ${ok.flatMap((r) => r.audio!.bargeOutcomes).filter((b) => b.pacepayStoppedMs !== null && b.pacepayStoppedMs < 1000).length}`);
  L.push(`- transcription errors that changed meaning: ${sum((r) => r.audio!.asrMeaningErrors)} of ${sum((r) => r.audio!.asr.length)} lender lines`);
  L.push(`- ended cleanly: ${ok.filter((r) => r.audio!.endedCleanly).length}/${ok.length}`);
  L.push(`- safety (critical issues from rules/judge, non-audio): ${results.reduce((n, r) => n + (r.grade?.issues.filter((i) => i.severity === 'critical' && !String(i.cause ?? '').startsWith('voice:')).length ?? 0), 0)}`);
  L.push('', '## Per call', '', '| id | pass | voice | end | outcome | turns | p50/p90 ms | dead air | improv | dup | over/pause/self | asr | clean | top issues |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const a = r.audio;
    const bad = (r.grade?.issues ?? []).filter((i) => i.severity === 'critical' || i.severity === 'high').map((i) => `${i.severity[0]!.toUpperCase()}:${i.check}`).slice(0, 4).join(', ');
    L.push(`| ${r.persona.id} | ${r.grade?.pass ? 'yes' : '**no**'} | ${a?.voice ?? '-'} | ${r.endReason ?? '-'} | ${r.negotiation?.outcome ?? '-'} | ${r.call.filter((l) => l.who === 'lender').length} | ${a ? `${a.p50 ?? '-'}/${a.p90 ?? '-'}` : '-'} | ${a?.deadAir.length ?? '-'} | ${a?.improvised.length ?? '-'} | ${a?.duplicates.length ?? '-'} | ${a ? `${a.talkOverLender.length}/${a.intoPause.length}/${a.selfCut.length}` : '-'} | ${a?.asrMeaningErrors ?? '-'} | ${a ? (a.endedCleanly ? 'yes' : a.endNote.replace(/\|/g, '/').slice(0, 60)) : '-'} | ${(bad || (r.error ? `harness: ${r.error.split('\n')[0]!.slice(0, 80)}` : '')).replace(/\|/g, '/')} |`);
  }
  L.push('', '## Issues (critical/high first)', '');
  for (const sev of ['critical', 'high', 'medium'] as const) {
    for (const r of results) for (const i of (r.grade?.issues ?? []).filter((x) => x.severity === sev)) L.push(`- **${sev}** ${r.persona.id} [${i.by}:${i.check}${i.cause ? ` / ${i.cause}` : ''}] ${String(i.detail).replace(/\n/g, ' ').slice(0, 400)}`);
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
log(`${PERSONAS.length} personas (${[...new Set(PERSONAS.map((p) => p.category))].join(', ')}), concurrency ${CONC}, out=${OUT}`);
const slots: Slot[] = Array.from({ length: CONC }, (_, k) => ({
  k, serverPort: BASE + 10 * k, proxyPort: BASE + 10 * k + 1, workerPort: BASE + 10 * k + 2, agent: `pacepay-voice-stress-${k + 1}`,
  recs: [], inflightDecide: 0, workerLines: [], ready: false,
}));
for (const s of slots) for (const port of [s.serverPort, s.proxyPort, s.workerPort]) if (!(await portFree(port))) throw new Error(`port ${port} busy`);
process.on('exit', () => slots.forEach(killWorker));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => {
  slots.forEach(killWorker);
  process.exit(130);
});
const [snap] = await Promise.all([
  makeSnapshot().then((s) => (log('snapshot at the calling step ready'), s)),
  Promise.all(slots.map(async (s) => {
    await startProxy(s);
    await startWorker(s);
    log(`slot ${s.k}: worker ${s.agent} registered (server :${s.serverPort}, proxy :${s.proxyPort})`);
  })),
]);
const grader: any = await import('../stress/grade.mts');
const judgeSem = new Semaphore(6);
const results: AR[] = [];
let next = 0;
let done = 0;
const grading: Promise<void>[] = [];
await Promise.all(
  slots.map(async (slot) => {
    for (;;) {
      const i = next++;
      if (i >= PERSONAS.length) return;
      const p = PERSONAS[i]!;
      if (!slot.ready || slot.worker?.exitCode !== null) {
        log(`slot ${slot.k}: restarting worker`);
        killWorker(slot);
        await sleep(1500);
        await startWorker(slot).catch((e) => log(`slot ${slot.k} worker restart failed: ${e.message}`));
      }
      let r: AR;
      try {
        r = await runCall(slot, p, snap);
      } catch (err) {
        r = { persona: p, ok: false, error: (err as Error).stack ?? String(err), endReason: 'error', call: [], texts: [], timings: { setupMs: 0, callMs: 0, postMs: 0, totalMs: 0, lenderLlmMs: 0, decideMs: [] } } as AR;
      }
      results[i] = r;
      done += 1;
      writeFileSync(join(OUT, 'calls', `${p.id}.json`), JSON.stringify(r, null, 2));
      const a = r.audio;
      log(`${done}/${PERSONAS.length} ${p.id} slot${slot.k} end=${r.endReason} outcome=${r.negotiation?.outcome ?? '-'} lat p50/p90=${a?.p50}/${a?.p90} improv=${a?.improvised.length} dup=${a?.duplicates.length} dead=${a?.deadAir.length} clean=${a?.endedCleanly} ${(r.timings.totalMs / 1000).toFixed(0)}s${r.error ? ` ERR ${r.error.split('\n')[0]!.slice(0, 160)}` : ''}`);
      grading.push(
        judgeSem.run(async () => {
          try {
            r.grade = r.call.length ? await grader.gradeOne(r, { judge: !NO_JUDGE }) : { pass: false, issues: [], facts: {} };
          } catch (err) {
            r.grade = { pass: false, issues: [{ check: 'grader', severity: 'high', detail: (err as Error).message, by: 'rule' }], facts: {} };
          }
          r.grade!.issues.push(...audioIssues(r));
          if (!r.ok) r.grade!.issues.push({ check: 'harness', severity: 'high', detail: (r.error ?? '').split('\n')[0]!, by: 'rule', cause: 'harness' });
          r.grade!.pass = !r.grade!.issues.some((x) => x.severity === 'critical' || x.severity === 'high');
          writeFileSync(join(OUT, 'calls', `${p.id}.json`), JSON.stringify(r, null, 2));
          const bad = r.grade!.issues.filter((x) => x.severity === 'critical' || x.severity === 'high');
          log(`graded ${p.id}: ${r.grade!.pass ? 'PASS' : 'FAIL'} ${bad.map((x) => `${x.severity}:${x.check}`).slice(0, 5).join('; ')}`);
        }),
      );
    }
  }),
);
await Promise.all(grading);
slots.forEach(killWorker);
const md = audioReport(results.filter(Boolean));
writeFileSync(join(OUT, 'report.md'), md + '\n\n---\n\n' + grader.report(results.filter((r) => r.grade), { source: 'stress-audio', concurrency: CONC }));
writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
rmSync(SCRATCH, { recursive: true, force: true });
log(`report: ${join(OUT, 'report.md')} (${((Date.now() - T_RUN) / 1000).toFixed(0)} s)`);
console.log(md.split('\n## Per call')[0]);
process.exit(0);
