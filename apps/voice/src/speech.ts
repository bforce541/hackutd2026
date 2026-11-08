/**
 * PacePay's mouth. Every word PacePay says on a call goes through speak(): the text is fixed by code
 * (the negotiator's `say`, an approval line, a hold line, a filler, the greeting) and is turned into
 * audio by OpenAI TTS (voice marin). The realtime model never writes a word of its own; it only listens
 * (turn detection and transcription). Implemented by: voice.
 *
 * Every line is synthesized WHOLE (per sentence group), checked, then played from memory:
 *  - streaming started on a tiny first chunk (a stutter at the start of lines) and a long line once
 *    turned to noise mid-stream; an opener clip + streamed rest froze and restarted mid-line. Gone.
 *  - the check (audio-check.ts) catches what TTS gets wrong now and then: a line said twice or drawn
 *    out ("Mm-hm" for 2.6 s, "Got it." for 6 s), a deeper voice (median pitch ~136 Hz vs marin's
 *    ~175-240 Hz), clipping, a run of noise.
 *  - BAKED clips (apps/voice/clips, made by scripts/voice-test/bake-clips.mts): the fillers and every
 *    fixed line (greeting, PIN lines, goodbye, refusals, hold line) were synthesized many times ahead
 *    of time and the take nearest marin's usual pitch was kept. They load at start, play instantly and
 *    sound the same on every call (no "deep" goodbye on one call and a squeaky one on the next).
 *  - a live line: two takes are synthesized AT ONCE (a hedge: TTS time and quality vary per request);
 *    the first clean take in marin's usual pitch band plays; if both fail the check, two more. A long
 *    line is split at sentence ends into up to three parts synthesized in parallel: the first part
 *    plays as soon as it is ready while the rest finish (~1 s sooner on a 25-word answer).
 *  - synthesis starts the moment the server's answer arrives (startLine), before the line is queued.
 *  - a clip that passed the check is kept, so the same line plays at once the next time.
 *
 * If TTS fails every try, the line falls back to the realtime model with "say exactly this" and no
 * tools, so a call never goes silent (agent.ts).
 */
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { clipBadness, clipProblems, clipStats, samplesOf, type ClipStats } from './audio-check';

export const TTS_MODEL = process.env.PACEPAY_TTS_MODEL || 'gpt-4o-mini-tts-2025-12-15';
export const TTS_VOICE = 'marin';
export const TTS_INSTRUCTIONS =
  'You are on a phone call. Sound like a warm, relaxed, friendly person, not a newsreader or an announcer. ' +
  'Natural conversational pace, light and easy, small pauses at commas. Read the words exactly as written. ' +
  'Keep the exact same voice, medium pitch and pace on every line: never deepen or lower your voice, never sound sleepy.';

/**
 * TTS says "Yoshua" wrong ("Yo-shoo-ah"). Every line goes to TTS with the name respelled the way it is
 * said; transcripts, logs and the Conductor keep "Yoshua". The cache is keyed by the respelled text, so
 * a respelling change never plays a stale clip.
 */
export const NAME_RESPELLING = process.env.PACEPAY_TTS_NAME || 'Yaw-shoo-uh';
export const ttsText = (text: string): string =>
  text
    .trim()
    .replace(/\bYoshua\b/g, NAME_RESPELLING)
    // A reference like "K7Q2M9" is read one character at a time ("K, 7, Q, 2, M, 9"), never as a word.
    .replace(/\b(?=[A-Z0-9]{5,10}\b)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]+\b/g, (m) => m.split('').join(', '));

const SAMPLE_RATE = 24_000;
const FRAME_SAMPLES = 480; // 20 ms at 24 kHz
const FRAME_BYTES = FRAME_SAMPLES * 2;
/** Frames handed to the audio source: 100 ms each (the source paces them in real time). */
const PIECE_BYTES = 5 * FRAME_BYTES;
/** Max tries per line: the first, then up to two more if the first fails the check. */
export const MAX_TRIES = 3;
const LIVE_TIMEOUT_MS = 8_000;
const WARM_TIMEOUT_MS = 20_000;

const log = (...a: unknown[]) => console.log(new Date().toISOString(), '[voice]', ...a);

/** Checked clips (PCM16 mono 24 kHz) by TTS text; `ready` once a clip passed the check. */
const cache = new Map<string, Promise<Uint8Array>>();
const ready = new Set<string>();

/**
 * Live lines first: background synthesis (prewarm) never starts a request while a live line is
 * waiting for its audio, so warming the likely lines never slows the line being said now.
 */
let liveWaiting = 0;
const liveIdle: Array<() => void> = [];
async function behindLive(): Promise<void> {
  while (liveWaiting > 0) await new Promise<void>((r) => liveIdle.push(r));
}
function liveStart(): () => void {
  liveWaiting++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--liveWaiting === 0) liveIdle.splice(0).forEach((r) => r());
  };
}

/** True once a line is synthesized, checked, and plays from memory. */
export const isReady = (text: string): boolean => ready.has(ttsText(text));

/**
 * TTS requests go over HTTP/1.1 keep-alive sockets, one per request in flight. Node's fetch speaks
 * HTTP/2 to api.openai.com and the streams on one connection are served one after another: a live
 * line waited ~1.5 s behind each background synthesis. On separate sockets they do not queue.
 */
const ttsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4 });

/** One whole TTS clip (PCM16 mono 24 kHz). */
function synthesize(text: string, timeoutMs: number): Promise<Uint8Array> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return Promise.reject(new Error('OPENAI_API_KEY is not set'));
  const body = JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, instructions: TTS_INSTRUCTIONS, response_format: 'pcm' });
  return new Promise<Uint8Array>((resolve, reject) => {
    const req = https.request(
      'https://api.openai.com/v1/audio/speech',
      {
        method: 'POST',
        agent: ttsAgent,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          clearTimeout(timer);
          const buf = Buffer.concat(chunks);
          if (status !== 200) return reject(new Error(`TTS ${status}: ${buf.toString('utf8').slice(0, 200)}`));
          if (buf.length < FRAME_BYTES * 5) return reject(new Error('TTS returned no audio'));
          resolve(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error(`TTS took over ${timeoutMs} ms`)), timeoutMs);
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end(body);
  });
}

interface Take {
  pcm: Uint8Array;
  stats: ClipStats;
  problems: string[];
  badness: number;
}

function check(text: string, pcm: Uint8Array): Take {
  const stats = clipStats(samplesOf(pcm), text);
  const problems = clipProblems(stats);
  return { pcm, stats, problems, badness: problems.length ? clipBadness(stats) : 0 };
}

const short = (t: string) => (t.length > 48 ? `${t.slice(0, 45)}...` : t);

/**
 * marin's usual pitch: a clean take inside this band plays at once; a clean take outside it (still
 * within the check's hard limits) waits CORE_WAIT_MS for a hedge take nearer TARGET_F0.
 */
export const TARGET_F0 = 205;
export const CORE_F0: readonly [number, number] = [175, 250];
const CORE_WAIT_MS = 400;
const pitched = (t: Take) => t.stats.voicedFrames >= 8;
const inCore = (t: Take) => !pitched(t) || (t.stats.f0 >= CORE_F0[0] && t.stats.f0 <= CORE_F0[1]);
const pitchDist = (t: Take) => (pitched(t) ? Math.abs(t.stats.f0 - TARGET_F0) : 0);
const nearest = (takes: Take[]) => takes.filter((t) => !t.problems.length).sort((x, y) => pitchDist(x) - pitchDist(y))[0];

/**
 * `n` takes of `text` at once. Resolves with the first clean take in marin's usual band, or (when a
 * clean take is outside it) the clean take nearest her usual pitch CORE_WAIT_MS later, or undefined
 * once all `n` are back and none is clean. Every take lands in `takes`.
 */
function round(text: string, n: number, timeoutMs: number, takes: Take[], errs: unknown[]): Promise<Take | undefined> {
  return new Promise((resolve) => {
    let left = n;
    let done = false;
    let wait: NodeJS.Timeout | undefined;
    const finish = (t: Take | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(wait);
      resolve(t);
    };
    for (let i = 0; i < n; i++) {
      synthesize(text, timeoutMs).then(
        (pcm) => {
          const t = check(text, pcm);
          takes.push(t);
          left--;
          if (!t.problems.length && inCore(t)) return finish(t);
          if (left === 0) return finish(nearest(takes));
          if (!t.problems.length && !wait) wait = setTimeout(() => finish(nearest(takes)), CORE_WAIT_MS);
        },
        (err) => {
          errs.push(err);
          if (--left === 0) finish(nearest(takes));
        },
      );
    }
  });
}

/**
 * A checked clip for `text`. Live: two takes at once, then two more if neither is clean. Background
 * (prewarm): one take, then two more. The first clean take wins (see round); if none is clean, the
 * least bad of all. Rejects only if no take produced audio at all.
 */
async function checkedClip(text: string, live: boolean): Promise<Take & { tries: number; ms: number }> {
  const t0 = Date.now();
  const timeout = live ? LIVE_TIMEOUT_MS : WARM_TIMEOUT_MS;
  const takes: Take[] = [];
  const errs: unknown[] = [];
  const rounds = live ? [2, 2] : [1, 2];
  let pick: Take | undefined;
  for (const n of rounds) {
    pick = await round(text, n, timeout, takes, errs);
    if (pick) break;
  }
  const ms = Date.now() - t0;
  const failed = takes.filter((t) => t.problems.length);
  if (!pick) {
    pick = [...takes].sort((a, b) => a.badness - b.badness)[0];
    if (!pick) {
      const lastErr = errs.at(-1);
      log(`tts check: "${short(text)}" no audio after ${errs.length} tries (${(lastErr as Error)?.message})`);
      throw lastErr instanceof Error ? lastErr : new Error('TTS failed');
    }
  }
  if (failed.length || pick.problems.length)
    log(
      `tts check: "${short(text)}" ${failed.length} of ${takes.length} take(s) failed (${failed.map((t) => t.problems.join('; ')).join(' | ')}); ` +
        `${pick.problems.length ? `kept the least bad (${pick.problems.join('; ')})` : 'played a clean take'} (${pick.stats.soundSec.toFixed(2)} s, ${pick.stats.f0} Hz) in ${ms} ms`,
    );
  return { ...pick, tries: takes.length + errs.length, ms };
}

/**
 * Synthesize a line, check it and keep it (fillers, PIN lines, the greeting): it then plays instantly.
 * A clip still failing the check after all tries is never kept (the live path tries again).
 */
export function prewarm(line: string): Promise<Uint8Array> {
  const text = ttsText(line);
  let p = cache.get(text);
  if (!p) {
    p = (async () => {
      await behindLive();
      const take = await checkedClip(text, false);
      if (take.problems.length) throw new Error(`clip failed the check: ${take.problems.join('; ')}`);
      return take.pcm;
    })();
    p.then(
      () => ready.add(text),
      () => cache.delete(text),
    );
    cache.set(text, p);
  }
  return p;
}

// -- baked clips -------------------------------------------------------------------------------

/** Where baked clips live: raw PCM16 mono 24 kHz files plus manifest.json (text -> file). */
export const CLIPS_DIR = fileURLToPath(new URL('../clips/', import.meta.url));
export interface BakedClip {
  /** The TTS text (ttsText of the line) the clip says. */
  text: string;
  file: string;
  f0: number;
  soundSec: number;
}
export interface BakedManifest {
  model: string;
  voice: string;
  clips: BakedClip[];
}
let bakedCount = 0;
/** Load the baked clips into the cache (once, at import). Missing or for another voice: none are used. */
function loadBaked(): void {
  if (process.env.PACEPAY_VOICE_NO_BAKED === '1') return;
  let m: BakedManifest;
  try {
    m = JSON.parse(readFileSync(join(CLIPS_DIR, 'manifest.json'), 'utf8')) as BakedManifest;
  } catch {
    return;
  }
  if (m.model !== TTS_MODEL || m.voice !== TTS_VOICE) {
    log(`baked clips are for ${m.voice}/${m.model}, not ${TTS_VOICE}/${TTS_MODEL}: not used`);
    return;
  }
  for (const c of m.clips) {
    try {
      const buf = readFileSync(join(CLIPS_DIR, c.file));
      if (buf.length < FRAME_BYTES * 5) continue;
      cache.set(c.text, Promise.resolve(new Uint8Array(buf.buffer, buf.byteOffset, buf.length & ~1)));
      ready.add(c.text);
      bakedCount++;
    } catch {
      /* that one is synthesized live */
    }
  }
}
/** How many baked clips loaded (logs, tests). */
export const bakedClips = (): number => bakedCount;

function frame(bytes: Uint8Array): AudioFrame {
  const copy = new Uint8Array(bytes); // aligned copy
  const samples = new Int16Array(copy.buffer, 0, copy.length >> 1);
  return new AudioFrame(samples, SAMPLE_RATE, 1, samples.length);
}

/** TTS audio opens with a breath of near-silence; skipping it makes every line start sooner. */
const LEAD_LEVEL = 400;
const LEAD_PAD_BYTES = FRAME_BYTES; // keep 20 ms before the first sound
/** Keep this much quiet after the last sound (a natural end, no click). */
const TAIL_BYTES = 6 * FRAME_BYTES; // 120 ms

const level = (buf: Uint8Array, i: number) => Math.abs((buf[i]! | (buf[i + 1]! << 8)) << 16 >> 16);

/** Byte offset to start playing from (just before the first audible sample), or -1 if none. */
function soundStart(buf: Uint8Array): number {
  for (let i = 0; i + 1 < buf.length; i += 2) if (level(buf, i) >= LEAD_LEVEL) return Math.max(0, i - LEAD_PAD_BYTES);
  return -1;
}

/** Byte offset just after the last audible sample plus `tail`, never past the end. */
function soundEnd(buf: Uint8Array, tail: number): number {
  for (let i = (buf.length & ~1) - 2; i >= 0; i -= 2) if (level(buf, i) >= LEAD_LEVEL) return Math.min(buf.length & ~1, i + 2 + tail);
  return buf.length & ~1;
}

/**
 * Where to pick a line up again `fromMs` into its sound: the start of the quietest 40 ms within the
 * 500 ms before that point (a gap between words), so a resumed line never starts mid-syllable.
 */
function resumeOffset(pcm: Uint8Array, lead: number, fromMs: number): number {
  const target = lead + Math.round((fromMs / 1000) * SAMPLE_RATE) * 2;
  const win = 2 * FRAME_BYTES; // 40 ms
  let best = target;
  let bestE = Infinity;
  for (let off = target; off >= Math.max(lead, target - 25 * FRAME_BYTES); off -= FRAME_BYTES / 2) {
    let e = 0;
    for (let i = off; i + 1 < Math.min(pcm.length, off + win); i += 8) e += level(pcm, i);
    if (e < bestE) {
      bestE = e;
      best = off;
    }
  }
  return Math.min(best - (best % 2), pcm.length & ~1);
}

/** 100 ms frames of a whole clip, from just before its first sound (or `fromMs` into it) to just after its last. */
function* pcmFrames(pcm: Uint8Array, fromMs = 0): Generator<AudioFrame> {
  const lead = Math.max(0, soundStart(pcm));
  const end = soundEnd(pcm, TAIL_BYTES);
  const start = fromMs > 0 ? resumeOffset(pcm, lead, fromMs) : lead;
  for (let off = start; off < end; off += PIECE_BYTES) yield frame(pcm.subarray(off, Math.min(end, off + PIECE_BYTES)));
}

/** Milliseconds of audio a clip plays (what pcmFrames yields). */
export function playedMs(pcm: Uint8Array): number {
  return Math.round(((soundEnd(pcm, TAIL_BYTES) - Math.max(0, soundStart(pcm))) / 2 / SAMPLE_RATE) * 1000);
}

/** A line's frames, with how long it plays and how long its sound runs (for logs and the test harness). */
export type LineAudio = ReadableStream<AudioFrame> & { playMs: number; soundMs: number };

/** Test harness only: keep each played clip, so what the caller heard can be lined up against it. */
function dumpClip(text: string, pcm: Uint8Array): void {
  const dump = process.env.PACEPAY_VOICE_DUMP_DIR;
  if (!dump) return;
  void import('node:fs').then((fs) => fs.writeFileSync(`${dump}/${createHash('sha1').update(text).digest('hex').slice(0, 12)}.pcm`, pcm)).catch(() => undefined);
}

function lineAudio(pcm: Uint8Array, fromMs: number, soundSec?: number, text?: string): LineAudio {
  if (text) dumpClip(text, pcm);
  const st = toStream(pcmFrames(pcm, fromMs)) as LineAudio;
  st.playMs = playedMs(pcm);
  st.soundMs = Math.round((soundSec ?? clipStats(samplesOf(pcm), '').soundSec) * 1000);
  return st;
}

function toStream(gen: Generator<AudioFrame> | AsyncGenerator<AudioFrame>): ReadableStream<AudioFrame> {
  return new ReadableStream<AudioFrame>({
    async pull(controller) {
      const r = await gen.next();
      if (r.done) controller.close();
      else controller.enqueue(r.value);
    },
    cancel() {
      void gen.return(undefined);
    },
  });
}

/** How the last line was produced (for logs). */
export let lastTtsInfo = '';

// -- live lines: split, synthesized in parallel, started early ----------------------------------

/** Quiet between two parts of a split line (plus each part's own 120 ms tail): a sentence pause. */
const PART_GAP_BYTES = 10 * FRAME_BYTES; // 200 ms
/** A line this long (words) or longer, with more than one sentence, is split into parts. */
export const SPLIT_MIN_WORDS = 14;
/** No part shorter than this (a short first sentence joins the next one). */
const PART_MIN_WORDS = 6;
const MAX_PARTS = 3;
const ABBREV = /\b(?:vs|mr|mrs|ms|dr|st|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|no|approx|etc|e\.g|i\.e)\.$/i;
const wordsIn = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * A line's parts for synthesis: whole sentences, each at least PART_MIN_WORDS words, at most
 * MAX_PARTS; a line under SPLIT_MIN_WORDS words stays whole.
 */
export function splitForSpeech(text: string): string[] {
  const t = text.trim();
  if (wordsIn(t) < SPLIT_MIN_WORDS) return [t];
  const sentences: string[] = [];
  // Sentence ends, and the "; " between items of a list ("mortgage $1,200 on Monday; car payment $400...").
  for (const s of t.split(/(?<=[.!?])\s+(?=["'$A-Z0-9])|(?<=;)\s+/)) {
    if (sentences.length && ABBREV.test(sentences[sentences.length - 1]!)) sentences[sentences.length - 1] += ` ${s}`;
    else sentences.push(s);
  }
  const parts: string[] = [];
  let cur = '';
  for (const s of sentences) {
    cur = cur ? `${cur} ${s}` : s;
    if (wordsIn(cur) >= PART_MIN_WORDS) {
      parts.push(cur);
      cur = '';
    }
  }
  if (cur) {
    if (parts.length) parts[parts.length - 1] += ` ${cur}`;
    else parts.push(cur);
  }
  while (parts.length > MAX_PARTS) parts.splice(parts.length - 2, 2, `${parts[parts.length - 2]} ${parts[parts.length - 1]}`);
  return parts;
}

/** A sentence this long (words) is split once more, at the comma or colon nearest its middle. */
const LONG_PART_WORDS = 20;
/** Quiet at such a split: a comma pause (each part keeps its own 120 ms tail and 20 ms lead). */
const COMMA_GAP_BYTES = 4 * FRAME_BYTES; // 80 ms

/**
 * The parts a line is synthesized in, each with the quiet before it: whole sentences (splitForSpeech),
 * and a very long sentence ("When it matures Friday, November 20th, PacePay's pick is ..., and put the
 * other $2,786 in savings: about $550 a year less...", 34 words, 3.1 s to synthesize) also at a comma.
 */
export function speechParts(text: string): { text: string; gapBytes: number }[] {
  const out: { text: string; gapBytes: number }[] = [];
  for (const [i, p] of splitForSpeech(text).entries()) {
    const gap = i ? PART_GAP_BYTES : 0;
    const words = p.split(/\s+/);
    if (words.length < LONG_PART_WORDS) {
      out.push({ text: p, gapBytes: gap });
      continue;
    }
    // Word indexes after which a comma or colon ends a word, both halves >= PART_MIN_WORDS words; not
    // inside a number ("$2,214" has no space) or a spelled reference ("K, 7, Q").
    let best = -1;
    for (let k = PART_MIN_WORDS - 1; k < words.length - PART_MIN_WORDS; k++) {
      if (!/[a-z0-9%)][,:]$/i.test(words[k]!) || /^[A-Z0-9],$/.test(words[k]!) || /^[A-Z0-9],?$/.test(words[k + 1]!)) continue;
      if (best < 0 || Math.abs(k - words.length / 2) < Math.abs(best - words.length / 2)) best = k;
    }
    if (best < 0) out.push({ text: p, gapBytes: gap });
    else {
      out.push({ text: words.slice(0, best + 1).join(' '), gapBytes: gap });
      out.push({ text: words.slice(best + 1).join(' '), gapBytes: COMMA_GAP_BYTES });
    }
  }
  return out;
}

/** One part of a line: its sound (trimmed to just before the first sound and 120 ms after the last). */
interface Part {
  pcm: Uint8Array;
  clean: boolean;
  f0: number;
  ms: number;
  tries: number;
}
interface LineJob {
  parts: Promise<Part>[];
  /** Quiet before each part (none before the first). */
  gaps: number[];
  startedAt: number;
}
/** Lines whose synthesis started before they were asked for (startLine), by TTS text. */
const jobs = new Map<string, LineJob>();
const JOB_TTL_MS = 60_000;

/** A clip from just before its first sound to 120 ms after its last (what plays; baked clips are stored so). */
export function trimmed(pcm: Uint8Array): Uint8Array {
  const a = Math.max(0, soundStart(pcm));
  return pcm.subarray(a, Math.max(a, soundEnd(pcm, TAIL_BYTES)));
}

function partFor(chunk: string): Promise<Part> {
  const live = (): Promise<Part> =>
    checkedClip(chunk, true).then((take) => {
      if (!take.problems.length && !cache.has(chunk)) {
        cache.set(chunk, Promise.resolve(take.pcm));
        ready.add(chunk);
      }
      return { pcm: trimmed(take.pcm), clean: !take.problems.length, f0: take.stats.f0, ms: take.ms, tries: take.tries };
    });
  // Only a finished clip: a background synthesis still waiting behind live lines would wait on this one.
  const known = ready.has(chunk) ? cache.get(chunk) : undefined;
  if (known) return known.then((pcm) => ({ pcm: trimmed(pcm), clean: true, f0: 0, ms: 0, tries: 0 }), live);
  return live();
}

function newJob(text: string): LineJob {
  const done = liveStart();
  const plan = speechParts(text);
  const parts = plan.map((p) => partFor(p.text));
  void Promise.allSettled(parts).then(done);
  return { parts, gaps: plan.map((p) => p.gapBytes), startedAt: Date.now() };
}

/**
 * Start synthesizing a line now (the server's answer just arrived), so it is ready, or nearly, by the
 * time it is queued. A line already in memory or already started is left alone.
 */
export function startLine(line: string): void {
  const text = ttsText(line);
  if (!text || cache.has(text) || jobs.has(text)) return;
  const now = Date.now();
  for (const [k, j] of jobs) if (now - j.startedAt > JOB_TTL_MS) jobs.delete(k);
  jobs.set(text, newJob(text));
}

/** The joined sound of a split line (parts with a pause between them). */
function joinParts(parts: Part[], gaps: number[]): Uint8Array {
  const total = parts.reduce((n, p, i) => n + p.pcm.length + (i ? gaps[i]! : 0), 0);
  const out = new Uint8Array(total);
  let o = 0;
  parts.forEach((p, i) => {
    if (i) o += gaps[i]!;
    out.set(p.pcm, o);
    o += p.pcm.length;
  });
  return out;
}

function remember(text: string, parts: Part[], gaps: number[]): Uint8Array {
  const pcm = parts.length === 1 ? parts[0]!.pcm : joinParts(parts, gaps);
  if (parts.every((p) => p.clean) && !cache.has(text)) {
    cache.set(text, Promise.resolve(pcm));
    ready.add(text);
  }
  return pcm;
}

const msOf = (bytes: number) => Math.round((bytes / 2 / SAMPLE_RATE) * 1000);

/**
 * A split line, played part by part: the first part plays as soon as it is ready; each later part
 * follows a sentence pause after the one before (they were all synthesized at the same time, so a
 * later part is nearly always ready by then). A part that fails outright ends the line there.
 */
function partsAudio(text: string, job: LineJob, first: Part): LineAudio {
  const n = job.parts.length;
  const st = toStream(
    (async function* () {
      for (let i = 0; i < n; i++) {
        let part: Part;
        try {
          part = i === 0 ? first : await job.parts[i]!;
        } catch (err) {
          log(`part ${i + 1} of "${short(text)}" has no audio (${(err as Error).message}); the line ends after part ${i}`);
          return;
        }
        const gap = i ? job.gaps[i]! : 0;
        for (let off = 0; off < gap; off += PIECE_BYTES) yield frame(new Uint8Array(Math.min(PIECE_BYTES, gap - off)));
        for (let off = 0; off < part.pcm.length; off += PIECE_BYTES) yield frame(part.pcm.subarray(off, Math.min(part.pcm.length, off + PIECE_BYTES)));
      }
    })(),
  ) as LineAudio;
  // Until every part is in: an estimate (marin speaks ~0.37 s a word); exact once they are.
  const restWords = wordsIn(text) - wordsIn(speechParts(text)[0]!.text);
  st.playMs = msOf(first.pcm.length) + Math.round(restWords * 370) + msOf(job.gaps.reduce((a, b) => a + b, 0));
  st.soundMs = Math.max(0, st.playMs - 140);
  void Promise.all(job.parts)
    .then((parts) => {
      const pcm = remember(text, parts, job.gaps);
      dumpClip(text, pcm);
      st.playMs = msOf(pcm.length);
      // Sound runs from 20 ms after the start (lead pad) to 120 ms before the end (tail).
      st.soundMs = Math.max(0, st.playMs - 140);
    })
    .catch(() => undefined);
  return st;
}

/**
 * Audio frames for one line (or the rest of it, from `fromMs` into its sound, picking up at a gap
 * between words): from memory if it was synthesized and checked before (or baked), else synthesized
 * now, or picked up where startLine began it. Resolves once the first part has a clean clip (~1 s).
 * Rejects only if TTS produced no audio at all, so the caller can fall back before anything is
 * scheduled.
 */
export async function audioFor(line: string, fromMs = 0): Promise<LineAudio> {
  const text = ttsText(line);
  if (cache.has(text)) {
    try {
      const pcm = await cache.get(text)!;
      lastTtsInfo = `from memory, ${playedMs(pcm)} ms of audio${fromMs ? `, from ${fromMs} ms` : ''}`;
      return lineAudio(pcm, fromMs, undefined, text);
    } catch {
      /* synthesize afresh below */
    }
  }
  const early = jobs.get(text);
  jobs.delete(text);
  const job = early ?? newJob(text);
  const t0 = Date.now();
  if (job.parts.length === 1 || fromMs > 0) {
    const parts = await Promise.all(job.parts);
    const pcm = remember(text, parts, job.gaps);
    const p = parts[0]!;
    lastTtsInfo = `${parts.length > 1 ? `${parts.length} parts` : 'whole line'} in ${Date.now() - job.startedAt} ms${early ? ` (started ${t0 - job.startedAt} ms early)` : ''}, ${playedMs(pcm)} ms of audio, ${p.f0} Hz${p.tries > 2 ? `, ${p.tries} tries` : ''}`;
    return lineAudio(pcm, fromMs, undefined, text);
  }
  const first = await job.parts[0]!;
  lastTtsInfo = `first of ${job.parts.length} parts in ${Date.now() - job.startedAt} ms${early ? ` (started ${t0 - job.startedAt} ms early)` : ''}, ${first.f0} Hz${first.tries > 2 ? `, ${first.tries} tries` : ''}`;
  return partsAudio(text, job, first);
}

loadBaked();
