/**
 * PacePay's mouth. Every word PacePay says on a call goes through speak(): the text is fixed by code
 * (the negotiator's `say`, an approval line, a hold line, a filler, the greeting) and is turned into
 * audio by OpenAI TTS (voice marin), streamed as it is generated. The realtime model never writes a
 * word of its own; it only listens (turn detection and transcription). Implemented by: voice.
 *
 * If TTS fails to start, the line falls back to the realtime model with "say exactly this" and no
 * tools, so a call never goes silent.
 */
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import https from 'node:https';
import { Readable } from 'node:stream';

export const TTS_MODEL = process.env.PACEPAY_TTS_MODEL || 'gpt-4o-mini-tts-2025-12-15';
export const TTS_VOICE = 'marin';
export const TTS_INSTRUCTIONS =
  'You are on a phone call. Sound like a warm, relaxed, friendly person, not a newsreader or an announcer. ' +
  'Natural conversational pace, light and easy, small pauses at commas. Read the words exactly as written.';

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

/** PCM16 mono 24 kHz chunks of one line, cached once fully synthesized. */
const cache = new Map<string, Promise<Uint8Array>>();
const ready = new Set<string>();

/**
 * Live lines first: background synthesis (prewarm) never starts a request while a live line is
 * waiting for its first audio, so warming the likely lines never slows the line being said now.
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

/** True once a line is fully synthesized and plays from memory. */
export const isReady = (text: string): boolean => ready.has(ttsText(text));

/**
 * TTS requests go over HTTP/1.1 keep-alive sockets, one per request in flight. Node's fetch speaks
 * HTTP/2 to api.openai.com and the streams on one connection are served one after another: a live
 * line waited ~1.5 s behind each background synthesis (measured: 2.1 s with one in flight, 4.4 s with
 * two). On separate sockets a live line's first audio stays ~0.6 s whatever else is in flight.
 */
const ttsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4 });

function request(text: string, signal?: AbortSignal): Promise<Response> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return Promise.reject(new Error('OPENAI_API_KEY is not set'));
  const body = JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, instructions: TTS_INSTRUCTIONS, response_format: 'pcm' });
  return new Promise<Response>((resolve, reject) => {
    const req = https.request(
      'https://api.openai.com/v1/audio/speech',
      {
        method: 'POST',
        agent: ttsAgent,
        signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          let err = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (err += c));
          res.on('end', () => reject(new Error(`TTS ${status}: ${err.slice(0, 200)}`)));
          res.on('error', reject);
          return;
        }
        // A cancelled or aborted request ends the stream quietly; readers see it as done.
        res.on('error', () => undefined);
        resolve(new Response(Readable.toWeb(res) as unknown as globalThis.ReadableStream<Uint8Array>, { status }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Seconds of sound in a clip, from its first to its last audible sample. TTS now and then repeats or
 * rambles on a short input ("Okay, okay."); a clip much longer than its words should take is that.
 */
function soundSeconds(pcm: Uint8Array): number {
  const lead = Math.max(0, soundStart(pcm));
  return Math.max(0, soundEnd(pcm, 0) - lead) / 2 / SAMPLE_RATE;
}
const plausible = (text: string, pcm: Uint8Array, strict = false) => {
  const words = text.split(/\s+/).length;
  // A short opener ("Got it.") gets a tight bound: a doubled "Got it, got it." must not pass.
  return soundSeconds(pcm) <= (strict && words <= 3 ? 0.3 + words * 0.3 : 0.8 + words * 0.45);
};

/**
 * Synthesize a line fully and keep it (fillers, hold lines, the greeting): it then plays instantly.
 * A clip that came out far too long is synthesized again, and never kept if it still is.
 */
export function prewarm(line: string, strict = false): Promise<Uint8Array> {
  const text = ttsText(line);
  let p = cache.get(text);
  if (!p) {
    p = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await behindLive();
          const res = await request(text);
          const pcm = new Uint8Array(await res.arrayBuffer());
          if (plausible(text, pcm, strict)) return pcm;
          throw new Error(`clip came out ${soundSeconds(pcm).toFixed(1)}s long`);
        } catch (err) {
          if (attempt >= 1) {
            console.log(new Date().toISOString(), '[voice]', `not caching "${text}": ${(err as Error).message}`);
            throw err;
          }
        }
      }
    })();
    p.then(() => ready.add(text), () => cache.delete(text));
    cache.set(text, p);
  }
  return p;
}

function frame(bytes: Uint8Array): AudioFrame {
  const copy = new Uint8Array(bytes); // aligned copy
  const samples = new Int16Array(copy.buffer, 0, copy.length >> 1);
  return new AudioFrame(samples, SAMPLE_RATE, 1, samples.length);
}

/** TTS audio opens with a breath of near-silence; skipping it makes every line start sooner. */
const LEAD_LEVEL = 400;
const LEAD_PAD_BYTES = FRAME_BYTES; // keep 20 ms before the first sound
/** An opener keeps this much of its trailing quiet: the natural beat before the rest of the line. */
const OPENER_TAIL_BYTES = 8 * FRAME_BYTES; // 160 ms
/** A comma opener keeps a shorter beat: the rest of the line carries on mid-sentence. */
const COMMA_TAIL_BYTES = 5 * FRAME_BYTES; // 100 ms

const level = (buf: Uint8Array, i: number) => Math.abs((buf[i]! | (buf[i + 1]! << 8)) << 16 >> 16);

/** Byte offset to start playing from (just before the first audible sample), or -1 if none yet. */
function soundStart(buf: Uint8Array): number {
  for (let i = 0; i + 1 < buf.length; i += 2) if (level(buf, i) >= LEAD_LEVEL) return Math.max(0, i - LEAD_PAD_BYTES);
  return -1;
}

/** Byte offset just after the last audible sample plus `tail`, never past the end. */
function soundEnd(buf: Uint8Array, tail: number): number {
  for (let i = (buf.length & ~1) - 2; i >= 0; i -= 2) if (level(buf, i) >= LEAD_LEVEL) return Math.min(buf.length & ~1, i + 2 + tail);
  return buf.length & ~1;
}

/** Frames of a fully synthesized line, from its first sound. */
function* pcmFrames(pcm: Uint8Array, end = pcm.length & ~1): Generator<AudioFrame> {
  const lead = soundStart(pcm.subarray(0, end));
  for (let off = lead > 0 ? lead : 0; off < end; off += FRAME_BYTES * 5) {
    yield frame(pcm.subarray(off, Math.min(end, off + FRAME_BYTES * 5)));
  }
}

/** If the first TTS request has not produced audio by now, a second one races it. */
export const HEDGE_MS = 650;
/** No audio by now: give up, so the line falls back to the realtime voice instead of a long silence. */
export const TTS_START_MAX_MS = 2_500;

type Started = { reader: ReadableStreamDefaultReader<Uint8Array>; first: Uint8Array; ctrl: AbortController };

/** One TTS request, resolved once its first audio bytes arrive. */
async function firstChunk(text: string): Promise<Started> {
  const ctrl = new AbortController();
  const res = await request(text, ctrl.signal);
  const reader = res.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const r = await reader.read();
  if (r.done || !r.value?.length) throw new Error('TTS returned no audio');
  return { reader, first: r.value, ctrl };
}

/**
 * Start a line's audio as fast as possible: a request, plus a second one racing it if the first is
 * slow to produce audio (or failed). The loser is aborted.
 */
async function startTts(text: string): Promise<Started & { ms: number; hedged: boolean }> {
  const done = liveStart();
  try {
    return await startTtsLive(text);
  } finally {
    done();
  }
}

async function startTtsLive(text: string): Promise<Started & { ms: number; hedged: boolean }> {
  const t0 = Date.now();
  let launched = false;
  const losers: Promise<Started>[] = [];
  const first = firstChunk(text);
  const second = new Promise<Started>((resolve, reject) => {
    const launch = () => {
      if (launched) return;
      launched = true;
      clearTimeout(timer);
      const p = firstChunk(text);
      losers.push(p);
      p.then(resolve, reject);
    };
    const timer = setTimeout(launch, HEDGE_MS);
    first.then(() => {
      if (!launched) {
        clearTimeout(timer);
        reject(new Error('not needed'));
      }
    }, launch);
  });
  let timer: NodeJS.Timeout | undefined;
  const giveUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no TTS audio within ${TTS_START_MAX_MS} ms`)), TTS_START_MAX_MS);
  });
  let win: Started;
  try {
    win = await Promise.race([Promise.any([first, second]), giveUp]);
  } catch (err) {
    for (const p of [first, ...losers]) void p.then((st) => st.ctrl.abort(), () => undefined);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  for (const p of [first, ...losers]) {
    void p.then((st) => {
      if (st !== win) st.ctrl.abort();
    }, () => undefined);
  }
  return { ...win, ms: Date.now() - t0, hedged: launched };
}

const START_CUSHION_BYTES = 4 * FRAME_BYTES; // 80 ms
const PIECE_BYTES = 5 * FRAME_BYTES; // 100 ms
/** Frames of a streaming TTS response as it arrives, from its first sound. */
async function* streamFrames(st: Started): AsyncGenerator<AudioFrame> {
  let carry: Uint8Array = new Uint8Array(0);
  let next: Uint8Array | undefined = st.first;
  let leading = true;
  let started = false;
  for (;;) {
    let value = next;
    next = undefined;
    if (!value) {
      const r = await st.reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (r.done) break;
      value = r.value;
    }
    let buf = new Uint8Array(carry.length + value.length);
    buf.set(carry);
    buf.set(value, carry.length);
    if (leading) {
      const at = soundStart(buf);
      if (at < 0) {
        // Still silent: keep only the pad's worth, starting on a whole sample.
        const from = Math.max(0, buf.length - LEAD_PAD_BYTES);
        carry = buf.subarray(from - (from % 2));
        continue;
      }
      leading = false;
      buf = buf.subarray(at);
    }
    // The first audio waits for a small cushion, so a gap between the first network chunks does
    // not stutter the opening syllable; after that, whole 20 ms frames in pieces of at most 100 ms.
    if (!started && buf.length < START_CUSHION_BYTES) {
      carry = buf;
      continue;
    }
    started = true;
    const usable = buf.length - (buf.length % FRAME_BYTES);
    carry = buf.subarray(usable);
    for (let off = 0; off < usable; off += PIECE_BYTES) yield frame(buf.subarray(off, Math.min(usable, off + PIECE_BYTES)));
  }
  const tail = carry.subarray(0, carry.length - (carry.length % 2));
  if (tail.length && !leading) yield frame(tail);
}

function toStream(gen: AsyncGenerator<AudioFrame> | Generator<AudioFrame>, onCancel?: () => void): ReadableStream<AudioFrame> {
  return new ReadableStream<AudioFrame>({
    async pull(controller) {
      const r = await gen.next();
      if (r.done) controller.close();
      else controller.enqueue(r.value);
    },
    cancel() {
      onCancel?.();
      void gen.return(undefined);
    },
  });
}

/**
 * Openers the negotiator starts lines with. Kept synthesized, so a line like "Thanks for holding.
 * Yoshua approved..." starts at once while the rest is still being synthesized. Whole sentences, plus
 * the read-back openers ending in a comma: those take over a second to say, longer than the rest of
 * the line takes to start (~0.6 s), so the rest follows on the comma's natural beat. Never a one-word
 * opener (TTS tends to repeat those: "Okay, okay."); a two-word one only with the tight length check
 * in plausible().
 */
export const OPENERS = [
  'Got it.',
  'Okay, so just to confirm,',
  'Just so I have it right,',
  'Sorry, just to make sure I have it right,',
  'And just to confirm,',
  'Thanks for holding.',
  'Thanks for waiting.',
  'Sorry for the wait.',
  'Sorry about that.',
  'Thanks for checking.',
  'No problem at all.',
];

/** Opener clips that came out the expected length (a repeated or rambling clip is never used). */
const goodOpeners = new Set<string>();

/** Synthesize the openers (prewarm keeps only clips the length their words should take). */
export async function prewarmOpeners(): Promise<void> {
  for (const o of OPENERS) {
    try {
      await prewarm(o, true);
      goodOpeners.add(o);
    } catch {
      /* not cached: lines starting with it just stream */
    }
  }
}

/** A line's longest cached opener and the rest of it, or null. */
export function splitOpener(line: string): { head: string; rest: string } | null {
  const t = ttsText(line);
  let best: { head: string; rest: string } | null = null;
  for (const m of t.matchAll(/[.!?,](?=\s+\S)/g)) {
    const end = m.index! + 1;
    if (end > 48) break;
    const head = t.slice(0, end);
    if (goodOpeners.has(head) && ready.has(head)) best = { head, rest: t.slice(end).trim() };
  }
  return best;
}

/** How the last line was produced (for logs). */
export let lastTtsInfo = '';

/**
 * Audio frames for one line. A cached line plays from memory. A line with a cached opener plays the
 * opener at once while the rest is synthesized. Otherwise this resolves once the TTS response has
 * produced audio (so a failure can fall back before anything is scheduled) and streams the rest as it
 * arrives. Cancelling the stream (an interruption) aborts the request.
 */
export async function audioFor(line: string): Promise<ReadableStream<AudioFrame>> {
  const text = ttsText(line);
  // Only a clip that is fully synthesized plays from memory; one still being warmed would make this
  // line wait for all of it, so it streams afresh instead (the warm one is kept for next time).
  const cached = ready.has(text) ? cache.get(text) : undefined;
  if (cached) {
    try {
      const pcm = await cached;
      lastTtsInfo = 'cached';
      return toStream(pcmFrames(pcm));
    } catch {
      /* synthesize afresh below */
    }
  }
  const split = splitOpener(text);
  if (split) {
    const head = await cache.get(split.head)!;
    const headEnd = soundEnd(head, split.head.endsWith(',') ? COMMA_TAIL_BYTES : OPENER_TAIL_BYTES);
    const t0 = Date.now();
    const rest = startTts(split.rest);
    rest.catch(() => undefined);
    let ctrl: AbortController | undefined;
    lastTtsInfo = `cached opener "${split.head}", rest streaming`;
    async function* joined(): AsyncGenerator<AudioFrame> {
      yield* pcmFrames(head, headEnd);
      let st: Awaited<typeof rest>;
      try {
        st = await rest;
      } catch (err) {
        console.error('[voice] TTS failed for the rest of a line:', (err as Error).message);
        return;
      }
      ctrl = st.ctrl;
      const late = Date.now() - t0 - st.ms;
      console.log(new Date().toISOString(), '[voice]', `rest of the line: first audio in ${st.ms} ms${st.hedged ? ' (hedged)' : ''}, ${late > 0 ? 'ready before the opener ended' : 'after the opener'}`);
      yield* streamFrames(st);
    }
    return toStream(joined(), () => {
      ctrl?.abort();
      void rest.then((st) => st.ctrl.abort(), () => undefined);
    });
  }
  const st = await startTts(text);
  lastTtsInfo = `first audio in ${st.ms} ms${st.hedged ? ' (hedged)' : ''}`;
  return toStream(streamFrames(st), () => st.ctrl.abort());
}
