/**
 * PacePay call stress harness. Test tooling only: never touches the live server (:8787), the live
 * voice worker or the dashboard. Every persona gets a fresh throwaway server (scripts/stress/server.mts)
 * on its own port and data dir, restored from a snapshot of the real flow at the calling step
 * (photo -> pick 1 -> OK limits, driven once per run through the real text path).
 *
 * The call itself runs through the REAL voice worker turn loop (apps/voice/src/conductor.ts
 * OutboundConductor + server.ts client) with a simulated phone line: lender turns come from an LLM
 * playing persona.behavior, optionally mangled like phone speech-to-text (persona.asr_noise,
 * deterministic per persona), PacePay's lines are whatever the conductor speaks (decide, the approval
 * poll, hold updates, fallbacks). Yoshua answers the deal approval by text through the real
 * /demo/customer-says path after persona.yoshua.approval_delay_s.
 *
 * Usage (from the repo root):
 *   npx @dotenvx/dotenvx run --convention=nextjs -q -- node_modules/.bin/tsx scripts/stress/run.mts \
 *     [--personas scripts/stress/personas (dir, file, or comma list; deduped by id)] \
 *     [--filter category|id-prefix[,more]] [--spread (round-robin categories)] [--limit N] \
 *     [--concurrency 8] [--out scripts/stress/out/<timestamp>] [--port 8990] [--lender mix|claude|super] [--judge-concurrency 12] \
 *     [--playout 1] [--setup snapshot|full] [--no-judge] [--no-grade]
 *   Regrade an existing run: tsx scripts/stress/grade.mts scripts/stress/out/<name> [--no-judge]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  REPO, Semaphore, apiFor, portFree, dayLabel, ensureDir, mangle, models, rng, seedOf, sleep, startChild, withBackoff,
  type CallLine, type Persona, type RunResult, type Source, type TextMsg,
} from './lib.mts';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const personasPath = resolve(REPO, arg('personas', 'scripts/stress/personas')!);
const filter = arg('filter');
const limit = arg('limit') ? Number(arg('limit')) : undefined;
const concurrency = Math.max(1, Number(arg('concurrency', '8')));
const outDir = ensureDir(resolve(REPO, arg('out', `scripts/stress/out/${stamp}`)!));
const basePort = Number(arg('port', process.env.STRESS_PORT ?? '8990'));
/** claude = Claude Opus plays every lender; super = Nemotron Super; mix (default) = split by persona id (Claude alone throttles past ~12 parallel calls). */
const lenderModel = arg('lender', 'mix')!;
const setupMode = arg('setup', 'snapshot')!;
const noJudge = arg('no-judge') === 'true';
/** Scales simulated TTS playout time (1 = real speed of ~6 ms/char; 0.3 for quick runs). */
const playoutScale = Math.max(0.05, Number(arg('playout', '1')));
const noGrade = arg('no-grade') === 'true';
const scratch = ensureDir(join(tmpdir(), `pacepay-stress-${stamp}`));
const callsDir = ensureDir(join(outDir, 'calls'));
const logsDir = ensureDir(join(outDir, 'logs'));

if (basePort <= 8787 && basePort + 601 > 8787) throw new Error('port range overlaps the live server');

/** A file, a directory of *.json persona arrays, or a comma list of either. Deduped by id (first wins). */
function loadPersonas(spec: string): Persona[] {
  const files: string[] = [];
  for (const part of spec.split(',')) {
    const f = resolve(REPO, part.trim());
    if (statSync(f).isDirectory()) {
      for (const n of readdirSync(f).sort()) if (n.endsWith('.json')) files.push(join(f, n));
    } else files.push(f);
  }
  const seen = new Set<string>();
  const out: Persona[] = [];
  for (const f of files) {
    const arr = JSON.parse(readFileSync(f, 'utf8'));
    for (const p of Array.isArray(arr) ? arr : [arr]) {
      if (!p?.id || !p.behavior || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
  }
  return out;
}
let personas: Persona[] = loadPersonas(arg('personas', 'scripts/stress/personas')!);
if (filter) {
  const fs = filter.split(',');
  personas = personas.filter((p) => fs.some((f) => p.category === f || p.id.startsWith(f)));
}
// --spread: round-robin across categories (so --limit 10 samples every category)
if (arg('spread') === 'true') {
  const by = new Map<string, Persona[]>();
  for (const p of personas) by.set(p.category, [...(by.get(p.category) ?? []), p]);
  const lists = [...by.values()];
  const rr: Persona[] = [];
  for (let i = 0; rr.length < personas.length; i++) for (const l of lists) if (l[i]) rr.push(l[i]!);
  personas = rr;
}
if (limit) personas = personas.slice(0, limit);
if (!personas.length) throw new Error(`no personas match (file ${personasPath}, filter ${filter ?? '-'})`);

const SEMS: Record<string, Semaphore> = {
  claude: new Semaphore(Number(process.env.STRESS_CLAUDE_CONCURRENCY ?? 12)),
  orchestrator: new Semaphore(Number(process.env.STRESS_SUPER_CONCURRENCY ?? 32)),
};
const lenderFor = (p: Persona): 'claude' | 'super' => (lenderModel === 'mix' ? (seedOf(p.id) % 2 ? 'claude' : 'super') : lenderModel === 'super' ? 'super' : 'claude');
const log = (...a: unknown[]) => console.log(`[stress ${new Date().toISOString().slice(11, 19)}]`, ...a);

// The real voice worker pieces (product code, imported read-only).
const conductorMod = await import(`${REPO}/apps/voice/src/conductor.ts`);
const serverMod = await import(`${REPO}/apps/voice/src/server.ts`);
const { OutboundConductor, holdUpdates, APPROVAL_FALLBACK_LINE } = conductorMod;

// ---------------------------------------------------------------------------
// Setup: drive the real flow to the calling step
// ---------------------------------------------------------------------------

const AFFIRM = /^(y|yes|yeah|yep|ok|okay|okk|sure|go|go ahead|do it|sounds good)\b/i;

async function driveToCall(api: ReturnType<typeof apiFor>, limitsReply = 'ok'): Promise<{ called: boolean; note: string }> {
  const cur = () => api('GET', '/api/cases/current');
  const pending = async (kind: string) => ((await cur()).approvals ?? []).some((a: any) => a.kind === kind && a.status === 'pending');
  const until = async (what: string, ok: () => Promise<boolean>, ms = 240_000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await ok()) return;
      if (Date.now() > end) throw new Error(`setup timed out waiting for ${what}`);
      await sleep(600);
    }
  };
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
  await api('POST', '/api/demo/customer-says', { text: limitsReply });
  if (!AFFIRM.test(limitsReply.trim())) {
    await sleep(8000);
    const st = await api('GET', '/__stress/state');
    const call = Object.values(st.calls ?? {}).find((c: any) => c.direction === 'outbound');
    return { called: !!call, note: `limits reply "${limitsReply}"` };
  }
  await until('the call row', async () => {
    const st = await api('GET', '/__stress/state');
    return Object.values(st.calls ?? {}).some((c: any) => c.direction === 'outbound' && c.status === 'dispatching');
  });
  // Let the agent finish whatever it does right after dialing (a "calling now" text etc).
  await until('agent idle', async () => {
    const i = await api('GET', '/__stress/idle');
    return i.inflight === 0 && i.quietMs > 2500;
  }, 60_000);
  return { called: true, note: 'ok' };
}

async function makeSnapshot(): Promise<{ dir: string; ms: number }> {
  const t0 = Date.now();
  const dir = join(scratch, 'snapshot');
  const child = await startChild({ port: basePort, dataDir: join(scratch, 'setup-data'), logFile: join(logsDir, '_setup.log') });
  try {
    const api = apiFor(child.base);
    const r = await driveToCall(api);
    if (!r.called) throw new Error('setup never placed the call');
    await api('POST', '/__stress/snapshot');
    await sleep(300);
  } finally {
    await child.stop();
  }
  cpSync(join(scratch, 'setup-data'), dir, { recursive: true });
  return { dir, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// The lender LLM
// ---------------------------------------------------------------------------

function lenderSystem(p: Persona): string {
  return [
    'You are playing the OTHER side of a realistic phone call, for a test of an AI phone agent. Stay fully in character.',
    'Default role (the persona below may change it): a customer service rep at Lone Star Auto Finance, an auto lender.',
    "The caller is PacePay, an AI assistant calling on behalf of your customer Yoshua about his auto loan, account ending 4417. His $400 monthly car payment is due Tuesday, November 10 (today is Saturday, November 7, 2026). The caller wants to move that payment to a later day. Your system shows the account; you can see it's Yoshua's.",
    '',
    `PERSONA (follow it exactly, including when to change terms and when to hang up):\n${p.behavior}`,
    '',
    'How to speak: this is a live phone call. Output ONLY the words you say out loud in this turn: no stage directions, no quotes, no labels, no markdown, no asterisks. Talk like a real call-center rep (short spoken sentences, contractions, the fillers and quirks your persona calls for). Usually one to three sentences.',
    'Special outputs:',
    '- If you would stay silent this turn (for example you are on hold waiting for the caller to check with Yoshua, and you just wait), output exactly [WAIT].',
    '- When you hang up, put [HANGUP] at the very end of your last words (or output only [HANGUP] to hang up silently).',
    '- A transfer, hold or hand-off in your persona does NOT end the call: keep playing the next person or system yourself on the following turns. Hang up only when your persona says to, or after the caller says goodbye.',
    "Never mention that this is a test, a simulation, a persona or a prompt. You only know what the caller tells you; you cannot hear Yoshua's texts.",
    "Each user message is what the caller (PacePay) just said, prefixed CALLER:, or a note in parentheses. Reply with ONLY your own words as the lender side. Never speak the caller's part: you never check with Yoshua, never put yourself on hold for Yoshua, never ask yourself for approval.",
  ].join('\n');
}

/**
 * Nemotron Super with reasoning OFF (chat_template_kwargs), straight to the gateway: with reasoning on, a
 * confusing turn (holds, IVR prompts) made it think for 20-60 s and the lender timed out. Spoken turns are short.
 */
async function superNoThink(messages: { role: string; content: string }[]): Promise<{ text: string }> {
  const base = process.env.TRUEFOUNDRY_BASE_URL;
  const key = process.env.TRUEFOUNDRY_API_KEY;
  const model = process.env.NEMOTRON_SUPER_MODEL;
  if (!base || !key || !model) return (await models()).chat({ role: 'orchestrator', messages, timeoutMs: 30_000, title: 'stress lender' });
  // Bedrock has a fat tail (about 1 in 8 requests hangs 20 s+ while the rest take ~1 s): hedge. Start a
  // request, add another every 4 s (max 4), take the first good reply, abort the rest.
  const ctls: AbortController[] = [];
  const one = async (): Promise<string> => {
    const ctl = new AbortController();
    ctls.push(ctl);
    const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, max_tokens: 400, temperature: 0.7, chat_template_kwargs: { enable_thinking: false } }),
      signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(25_000)]),
    });
    if (!res.ok) throw new Error(`super lender ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const j: any = await res.json();
    const text = String(j.choices?.[0]?.message?.content ?? '');
    if (!text.trim()) throw new Error('empty lender reply');
    return text;
  };
  try {
    const text = await new Promise<string>((resolve, reject) => {
      let failed = 0;
      let started = 0;
      const timers: NodeJS.Timeout[] = [];
      const launch = () => {
        started += 1;
        one().then(
          (t) => {
            timers.forEach(clearTimeout);
            resolve(t);
          },
          (e) => {
            failed += 1;
            if (failed >= 4 || (failed === started && started >= 4)) timers.forEach(clearTimeout), reject(new Error(/abort|timeout/i.test(String(e)) ? 'super lender timed out after 25000 ms' : String(e?.message ?? e)));
            else if (failed === started) launch(); // everything in flight failed fast: try again now
          },
        );
      };
      launch();
      for (const ms of [4000, 8000, 12000]) timers.push(setTimeout(() => started < 4 && launch(), ms));
    });
    return { text };
  } finally {
    ctls.forEach((c) => c.abort());
  }
}

async function lenderTurn(p: Persona, history: { role: 'user' | 'assistant'; content: string }[]): Promise<{ text: string; ms: number }> {
  const m = await models();
  // Merge consecutive same-role messages (Claude wants alternation) and start with the caller.
  const merged: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const h of history) {
    const last = merged[merged.length - 1];
    if (last && last.role === h.role) last.content += `\n${h.content}`;
    else merged.push({ ...h });
  }
  if (!merged.length || merged[0]!.role !== 'user') merged.unshift({ role: 'user', content: '(The call connects.)' });
  if (merged[merged.length - 1]!.role !== 'user') merged.push({ role: 'user', content: '(silence on the line)' });
  const messages = [{ role: 'system', content: lenderSystem(p) }, ...merged];
  // Claude on the gateway queues per user (requests run nearly one at a time under load), so a Claude
  // lender only falls back to Super, and a Super lender never falls back to Claude (that left the judge starved).
  const roles = lenderFor(p) === 'super' ? ['orchestrator'] : ['claude', 'orchestrator'];
  const t0 = Date.now();
  let lastErr: unknown;
  for (const role of roles) {
    try {
      const r = await SEMS[role]!.run(() =>
        withBackoff(`lender ${p.id}`, async () => {
          const out = role === 'orchestrator' ? await superNoThink(messages) : await m.chat({ role, messages, timeoutMs: 45_000, title: 'stress lender' });
          // Nemotron sometimes leaks its reasoning (or a bare </think>) into content: keep what follows it.
          let text = String(out.text ?? '');
          const th = text.lastIndexOf('</think>');
          if (th >= 0) text = text.slice(th + 8);
          text = text.replace(/<think>[\s\S]*$/i, '').trim();
          if (!text) throw new Error('empty lender reply');
          return text;
        }, role === 'claude' ? 2 : 4),
      );
      // Keep only the lender's own words: drop any CALLER: part the model wrote, collapse paragraphs.
      const own = r.split(/\n\s*(?:CALLER|PacePay)\s*:/i)[0]!.replace(/\s*\n\s*/g, ' ');
      return { text: own.replace(/^["']|["']$/g, '').replace(/^(lender|rep|agent)\s*:\s*/i, '').trim(), ms: Date.now() - t0 };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('lender model failed');
}

// ---------------------------------------------------------------------------
// One persona
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

let portCursor = 0;
/** Ports basePort+1 .. basePort+600, round robin, skipping busy ones (and never 8787/3000). */
async function nextPort(): Promise<number> {
  for (let i = 0; i < 600; i++) {
    const port = basePort + 1 + (portCursor++ % 600);
    if (port === 8787 || port === 3000) continue;
    if (await portFree(port)) return port;
  }
  throw new Error('no free port');
}

async function runPersona(p: Persona, slot: number, snapshotDir: string | undefined): Promise<RunResult> {
  const tStart = Date.now();
  const dataDir = join(scratch, `data-${p.id}`);
  const res: RunResult = {
    persona: p, ok: false, call: [], texts: [], workerLog: [], decideLog: [], approvalPolls: [],
    timings: { setupMs: 0, callMs: 0, postMs: 0, totalMs: 0, lenderLlmMs: 0, decideMs: [] },
  };
  res.lender = lenderFor(p);
  const limitsReply = p.yoshua?.limits_reply ?? 'yes';
  const restore = setupMode === 'snapshot' && AFFIRM.test(limitsReply.trim()) ? snapshotDir : undefined;
  // A fresh port per run (never reuse a slot's port while the last server may still be releasing it); one retry.
  let child: Awaited<ReturnType<typeof startChild>> | undefined;
  for (let attempt = 0; attempt < 2 && !child; attempt++) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      child = await startChild({ port: await nextPort(), dataDir, restore, logFile: join(logsDir, `${p.id}.log`) });
    } catch (err) {
      res.workerLog!.push(`boot attempt ${attempt + 1} failed: ${(err as Error).message}`);
    }
  }
  if (!child) {
    res.error = `harness: stress server did not boot (${res.workerLog!.join('; ')})`;
    res.endReason = 'error';
    res.timings.totalMs = Date.now() - tStart;
    return res;
  }
  const api = apiFor(child.base);
  let stopYoshua = false;
  try {
    if (!restore) {
      const r = await driveToCall(api, limitsReply);
      if (!r.called) {
        res.ok = true;
        res.endReason = 'no_call';
        const st = await api('GET', '/__stress/state');
        res.texts = (st.thread ?? []).map((m: any) => ({ dir: m.direction, text: m.text ?? '[image]', at: m.at }));
        res.caseState = st.cases?.[st.currentCaseId]?.state;
        return res;
      }
    }
    res.timings.setupMs = Date.now() - tStart;

    let st = await api('GET', '/__stress/state');
    const callRow: any = Object.values(st.calls).find((c: any) => c.direction === 'outbound' && c.status === 'dispatching');
    if (!callRow) throw new Error('no dispatching call in the restored state');
    const callId: string = callRow.id;
    const negId: string = callRow.negotiationId;
    res.callPlan = st.negotiations[negId]?.callPlan;
    const callStartIso = new Date().toISOString();
    res.callStartAt = callStartIso;
    res.acceptedChangesBefore = st.acceptedChanges;
    res.textsBefore = (st.thread ?? []).map((m: any) => ({ dir: m.direction, text: m.text ?? '[image]', at: m.at }));
    const preThread = (st.thread ?? []).length;
    const t0 = Date.now();
    const T = () => Date.now() - t0;

    // --- the voice server client, wrapped to see where each line came from
    const real = serverMod.createServerClient(child.base);
    const decideSays: string[] = [];
    const pendingDtmf: string[] = [];
    let turn = 0;
    const approvalSays: string[] = [];
    let lastServerActivity = Date.now();
    const client = {
      ...real,
      async decide(id: string, utterance: string) {
        const s = Date.now();
        // Raw POST (the worker's zod schema strips extra fields like dtmf); retry 429/5xx briefly.
        let out: any;
        for (let k = 0; ; k++) {
          try {
            out = await api('POST', `/api/voice/calls/${encodeURIComponent(id)}/decide`, { utterance });
            break;
          } catch (err) {
            const msg = (err as Error).message;
            if (k >= 3 || !/-> (429|502|503|504)\b|ECONN|fetch failed/.test(msg)) {
              res.workerLog!.push(`decide error: ${msg.slice(0, 200)}`);
              throw err;
            }
            await sleep(1000 * 2 ** k);
          }
        }
        const ms = Date.now() - s;
        res.timings.decideMs.push(ms);
        const extraKeys = Object.fromEntries(Object.entries(out ?? {}).filter(([k]) => !['say', 'next', 'state'].includes(k)));
        res.decideLog!.push({ utterance, say: out.say, next: out.next, state: out.state, ms, t: T(), ...extraKeys });
        if (out.dtmf) {
          pendingDtmf.push(String(out.dtmf));
          res.call.push({ who: 'pacepay', text: `[DTMF ${out.dtmf}]`, kind: 'dtmf', source: 'decide', turn, t: T() });
        }
        if (out.say) decideSays.push(norm(out.say));
        lastServerActivity = Date.now();
        return out;
      },
      async approval(id: string) {
        const out = await real.approval(id);
        if (out.status !== 'pending') {
          res.approvalPolls!.push({ status: out.status, say: out.say, next: out.next, t: T() });
          if (out.say) approvalSays.push(norm(out.say));
          lastServerActivity = Date.now();
        }
        return out;
      },
    };

    // --- the simulated phone line
    let ended = false;
    let endReason = '';
    let userSpeaking = false;
    let lastSpeakAt = 0;
    const holds = new Set<string>((holdUpdates('Yoshua') as string[]).map(norm));
    const spokenLines: CallLine[] = res.call;
    const sourceOf = (text: string, kind: string): Source => {
      const n = norm(text);
      if (kind === 'greeting') return 'greeting';
      if (kind === 'filler') return 'filler';
      if (n === norm(APPROVAL_FALLBACK_LINE)) return 'fallback';
      if (holds.has(n)) return 'hold_update';
      if (approvalSays.includes(n)) return 'approval';
      if (decideSays.includes(n)) return 'decide';
      return 'worker';
    };
    const portImpl = {
      async speak(text: string, kind: string) {
        if (ended) return undefined;
        lastSpeakAt = Date.now();
        spokenLines.push({ who: 'pacepay', text, kind, source: sourceOf(text, kind), turn, t: T() });
        if (kind !== 'filler') void real.event(callId, { type: 'transcript', speaker: 'pacepay', text }).catch(() => undefined);
        const dur = Math.round(Math.min(2500, 150 + text.length * 6) * playoutScale);
        return { playout: sleep(dur), interrupted: () => false };
      },
      userSpeaking: () => userSpeaking,
      agentSpeaking: () => false,
      async hangUp(reason: string) {
        if (ended) return;
        ended = true;
        endReason = /negotiator closed|approval (approved|declined|timeout)/.test(reason) ? 'negotiator_end' : /never resolved/.test(reason) ? 'worker_fallback' : `worker:${reason}`;
        res.workerLog!.push(`hangUp: ${reason}`);
        await real.event(callId, { type: 'ended' }).catch(() => undefined);
      },
      prepare() {},
      log: (...a: unknown[]) => res.workerLog!.push(a.map(String).join(' ')),
    };
    const conductor: any = new OutboundConductor(portImpl, client, callId, 'Yoshua');

    // --- Yoshua: answers each deal approval by text after the delay
    const yo = p.yoshua ?? {};
    const reply = yo.approval_reply ?? 'yes';
    const delay = Math.max(0, Number(yo.approval_delay_s ?? 5)) * 1000;
    const seenApprovals = new Set<string>();
    const yoshua = (async () => {
      while (!stopYoshua) {
        try {
          const c = await api('GET', '/api/cases/current');
          for (const a of c.approvals ?? []) {
            if (a.kind !== 'deal' || a.status !== 'pending' || seenApprovals.has(a.id)) continue;
            seenApprovals.add(a.id);
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
          /* server busy */
        }
        await sleep(500);
      }
    })();

    // --- call start: answered, then the greeting from the brief (exactly like agent.ts)
    await real.event(callId, { type: 'answered' });
    const brief = await real.brief(callId);
    await portImpl.speak(brief.greeting, 'greeting');

    const settle = async (maxMs = 30_000) => {
      const end = Date.now() + maxMs;
      while (Date.now() < end && !ended) {
        const quiet = Date.now() - Math.max(lastSpeakAt, lastServerActivity);
        if (!conductor.busy && !(conductor.pending?.length) && quiet >= 900) return;
        await sleep(100);
      }
    };
    const newPacepayLinesSince = (k: number) => spokenLines.slice(k).filter((l) => l.who === 'pacepay' && l.kind !== 'filler');

    const history: { role: 'user' | 'assistant'; content: string }[] = [];
    let shown = 0; // spoken lines already shown to the lender LLM
    const showNew = () => {
      for (; shown < spokenLines.length; shown++) {
        const l = spokenLines[shown]!;
        if (l.who === 'pacepay') history.push({ role: 'user', content: l.kind === 'dtmf' ? `(The caller pressed keys: ${l.text})` : `CALLER: ${l.text}` });
      }
      pendingDtmf.length = 0;
    };
    const rand = rng(seedOf(p.id));
    const noise = Math.max(0, Math.min(0.5, Number(p.asr_noise ?? 0)));
    const maxTurns = Math.max(2, Math.min(40, Number(p.max_turns ?? 16)));
    const extra = [...(yo.extra_texts ?? [])];
    let waits = 0;

    const deliver = async (heard: string, fragments?: string[]) => {
      if (fragments && fragments.length === 2) {
        if (rand() < 0.5) {
          // the first half is finalized while they keep talking: the conductor waits for the rest
          userSpeaking = true;
          conductor.onUserState(true);
          conductor.onTranscript(fragments[0]);
          await sleep(350);
          userSpeaking = false;
          conductor.onUserState(false);
          conductor.onTranscript(fragments[1]);
        } else {
          // a real pause: the first half goes to decide, the second lands while it runs
          conductor.onUserState(true);
          conductor.onUserState(false);
          conductor.onTranscript(fragments[0]);
          await sleep(250);
          conductor.onUserState(true);
          conductor.onUserState(false);
          conductor.onTranscript(fragments[1]);
        }
      } else {
        conductor.onUserState(true);
        conductor.onUserState(false);
        conductor.onTranscript(heard);
      }
    };
    const lenderHangsUp = async (why: string) => {
      if (ended) return;
      ended = true;
      endReason = why;
      conductor.stop();
      await real.event(callId, { type: 'ended' }).catch(() => undefined);
    };

    await settle(5000);
    while (!ended) {
      if (turn >= maxTurns) {
        await lenderHangsUp('max_turns');
        break;
      }
      showNew();
      const holding = !!conductor.approvalActive;
      if (holding) history.push({ role: 'user', content: '(You are on hold while the caller checks with Yoshua. Output [WAIT] to keep waiting silently, or say something.)' });
      let raw: string;
      try {
        const r = await lenderTurn(p, history);
        raw = r.text;
        res.timings.lenderLlmMs += r.ms;
      } catch (err) {
        res.error = `lender model: ${(err as Error).message}`;
        await lenderHangsUp('error');
        break;
      }
      if (holding) history.pop();
      if (ended) break; // PacePay hung up while the lender model was thinking
      const hang = /\[HANGUP\]/i.test(raw);
      const isWait = /^\[WAIT\]$/i.test(raw.trim()) || (/\[WAIT\]/i.test(raw) && !raw.replace(/\[WAIT\]/gi, '').trim());
      const said = raw.replace(/\[HANGUP\]|\[WAIT\]/gi, '').trim();
      if (isWait) {
        waits += 1;
        const before = spokenLines.length;
        const end = Date.now() + (holding ? 90_000 : 7_000);
        while (Date.now() < end && !ended && newPacepayLinesSince(before).length === 0) await sleep(250);
        if (!ended && newPacepayLinesSince(before).length === 0) history.push({ role: 'user', content: '(a few seconds of silence)' });
        if (waits > 10) await lenderHangsUp('lender_waited_out');
        await settle(8000);
        continue;
      }
      if (said) {
        turn += 1;
        for (const x of extra.filter((e) => e.at_turn === turn)) {
          res.texts.push({ dir: 'in', text: x.text, at: new Date().toISOString(), t: T() });
          void api('POST', '/api/demo/customer-says', { text: x.text }).catch((e) => res.workerLog!.push(`extra text failed: ${e.message}`));
        }
        history.push({ role: 'assistant', content: said });
        const mg = mangle(said, noise, rand);
        spokenLines.push({ who: 'lender', text: said, heard: mg.heard, asr: mg.ops.length ? mg.ops : undefined, turn, t: T() });
        void real.event(callId, { type: 'transcript', speaker: 'counterparty', text: mg.heard }).catch(() => undefined);
        lastServerActivity = Date.now();
        await deliver(mg.heard, mg.fragments);
      }
      if (hang) {
        await sleep(1200); // PacePay may start answering into a dead line
        await lenderHangsUp('lender_hangup');
        break;
      }
      await settle();
    }
    res.timings.callMs = Date.now() - t0;
    res.endReason = endReason;

    // --- after the call: wait for the agent to text Yoshua (Done / no deal / follow-up)
    const tPost = Date.now();
    const callEndAt = tPost;
    const endBy = Date.now() + 120_000;
    let quietSince = Date.now();
    let lastLen = -1;
    for (;;) {
      st = await api('GET', '/__stress/state');
      const c = st.cases?.[st.currentCaseId];
      const idle = st.__inflight === 0;
      const len = (st.thread ?? []).length;
      if (len !== lastLen) {
        lastLen = len;
        quietSince = Date.now();
      }
      // only texts sent after the call ended count (the approval prompt mid-call doesn't)
      const outAfter = (st.thread ?? []).slice(preThread).some((m: any) => m.direction === 'out' && Date.parse(m.at) >= callEndAt - 1500);
      const pendingApproval = Object.values(st.approvals ?? {}).some((a: any) => a.status === 'pending' && a.kind === 'deal');
      if (idle && !pendingApproval && (c?.state === 'DONE' || outAfter) && Date.now() - quietSince > 5000) break;
      // nothing texted: give the agent 30 s of idle after the call before calling it (graded as no_final_text)
      if (idle && !pendingApproval && !outAfter && Date.now() - tPost > 45_000 && Date.now() - quietSince > 8000) break;
      if (Date.now() > endBy) {
        res.workerLog!.push('post-call wait timed out (120 s)');
        break;
      }
      await sleep(700);
    }
    stopYoshua = true;
    await yoshua;
    res.timings.postMs = Date.now() - tPost;

    // --- capture
    const outTexts: TextMsg[] = (st.thread ?? [])
      .slice(preThread)
      .map((m: any) => ({ dir: m.direction, text: m.text ?? '[image]', at: m.at, t: Date.parse(m.at) - t0 }));
    // Keep Yoshua's own texts from the harness log (with approvalReply flags) and the server's thread for both directions.
    const harnessIn = res.texts;
    res.texts = outTexts.map((m) => {
      const h = m.dir === 'in' ? harnessIn.find((x) => x.text === m.text) : undefined;
      return h ? { ...m, approvalReply: h.approvalReply } : m;
    });
    for (const h of harnessIn) if (!res.texts.some((m) => m.dir === 'in' && m.text === h.text)) res.texts.push({ ...h, text: `${h.text} [not in thread]` });
    res.negotiation = st.negotiations[negId];
    res.approvals = Object.values(st.approvals ?? {}).filter((a: any) => a.kind === 'deal' && (a.negotiationId === negId || a.callId === callId));
    res.acceptedChanges = st.acceptedChanges;
    res.caseState = st.cases?.[st.currentCaseId]?.state ?? st.cases?.[res.negotiation?.caseId]?.state;
    res.callRow = st.calls[callId];
    res.ok = true;
  } catch (err) {
    res.error = (err as Error).stack ?? String(err);
    res.endReason ??= 'error';
  } finally {
    stopYoshua = true;
    await child.stop();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    res.timings.totalMs = Date.now() - tStart;
  }
  return res;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const tRun = Date.now();
log(`${personas.length} personas, concurrency ${concurrency}, lender=${lenderModel}, setup=${setupMode}, out=${outDir}`);
let snapshot: { dir: string; ms: number } | undefined;
if (setupMode === 'snapshot') {
  snapshot = await makeSnapshot();
  log(`snapshot at the calling step in ${(snapshot.ms / 1000).toFixed(1)} s`);
}
const results: RunResult[] = [];
let next = 0;
let done = 0;
// Grade each conversation as soon as its call ends (the Claude judge overlaps the remaining calls).
const grader = noGrade ? undefined : await import('./grade.mts');
const judgeSem = new Semaphore(Number(arg('judge-concurrency', '12')));
const grading: Promise<void>[] = [];
await Promise.all(
  Array.from({ length: Math.min(concurrency, personas.length) }, async (_, slot) => {
    for (;;) {
      const i = next++;
      if (i >= personas.length) return;
      const p = personas[i]!;
      const r = await runPersona(p, slot, snapshot?.dir);
      results[i] = r;
      writeFileSync(join(callsDir, `${p.id}.json`), JSON.stringify(r, null, 2));
      done += 1;
      const lastP = [...r.call].reverse().find((l) => l.who === 'pacepay');
      log(`${done}/${personas.length} ${p.id} ${r.ok ? 'ran' : 'HARNESS ERROR'} end=${r.endReason} outcome=${r.negotiation?.outcome ?? '-'} turns=${r.call.filter((l) => l.who === 'lender').length} ${(r.timings.totalMs / 1000).toFixed(0)}s${r.error ? ` err=${r.error.split('\n')[0]}` : ''} | last: ${lastP?.text.slice(0, 80) ?? ''}`);
      if (grader)
        grading.push(
          judgeSem.run(async () => {
            r.grade = await grader.gradeOne(r, { judge: !noJudge });
            const bad = r.grade.issues.filter((x) => x.severity === 'critical' || x.severity === 'high');
            log(`graded ${p.id}: ${r.grade.pass ? 'PASS' : 'FAIL'}${bad.length ? ` ${bad.map((x) => `${x.severity}:${x.cause ?? x.check}`).slice(0, 4).join('; ')}` : ''}`);
          }),
        );
    }
  }),
);
const callsWallMs = Date.now() - tRun;
log(`calls done in ${(callsWallMs / 1000).toFixed(0)} s`);
rmSync(scratch, { recursive: true, force: true });
await Promise.all(grading);
const meta = {
  personas: personasPath, filter, limit, concurrency, lenderModel, setupMode, startedAt: new Date(tRun).toISOString(),
  wallMs: Date.now() - tRun, callsWallMs, snapshotMs: snapshot?.ms, count: results.length,
};
writeFileSync(join(outDir, 'run.json'), JSON.stringify(meta, null, 2));
if (grader) {
  for (const r of results) writeFileSync(join(callsDir, `${r.persona.id}.json`), JSON.stringify(r, null, 2));
  writeFileSync(join(outDir, 'report.md'), grader.report(results, meta));
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  log(`report: ${join(outDir, 'report.md')}`);
}
log(`total ${((Date.now() - tRun) / 1000).toFixed(0)} s`);
process.exit(0);
