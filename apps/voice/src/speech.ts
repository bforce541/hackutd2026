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

export const TTS_MODEL = process.env.PACEPAY_TTS_MODEL || 'gpt-4o-mini-tts-2025-12-15';
export const TTS_VOICE = 'marin';
export const TTS_INSTRUCTIONS =
  'You are on a phone call. Sound like a warm, relaxed, friendly person, not a newsreader or an announcer. ' +
  'Natural conversational pace, light and easy, small pauses at commas. Read the words exactly as written.';

const SAMPLE_RATE = 24_000;
const FRAME_SAMPLES = 480; // 20 ms at 24 kHz
const FRAME_BYTES = FRAME_SAMPLES * 2;

/** PCM16 mono 24 kHz chunks of one line, cached once fully synthesized. */
const cache = new Map<string, Promise<Uint8Array>>();
const ready = new Set<string>();

/** True once a line is fully synthesized and plays from memory. */
export const isReady = (text: string): boolean => ready.has(text);

async function request(text: string, signal?: AbortSignal): Promise<Response> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, instructions: TTS_INSTRUCTIONS, response_format: 'pcm' }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`TTS ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res;
}

/**
 * Seconds of sound in a clip, from its first to its last audible sample. TTS now and then repeats or
 * rambles on a short input ("Okay, okay."); a clip much longer than its words should take is that.
 */
function soundSeconds(pcm: Uint8Array): number {
  const lead = Math.max(0, soundStart(pcm));
  return Math.max(0, soundEnd(pcm, 0) - lead) / 2 / SAMPLE_RATE;
}
const plausible = (text: string, pcm: Uint8Array) => soundSeconds(pcm) <= 0.8 + text.split(/\s+/).length * 0.45;

/**
 * Synthesize a line fully and keep it (fillers, hold lines, the greeting): it then plays instantly.
 * A clip that came out far too long is synthesized again, and never kept if it still is.
 */
export function prewarm(text: string): Promise<Uint8Array> {
  let p = cache.get(text);
  if (!p) {
    p = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await request(text);
          const pcm = new Uint8Array(await res.arrayBuffer());
          if (plausible(text, pcm)) return pcm;
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
export const HEDGE_MS = 450;
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

/** Frames of a streaming TTS response as it arrives, from its first sound. */
async function* streamFrames(st: Started): AsyncGenerator<AudioFrame> {
  let carry: Uint8Array = new Uint8Array(0);
  let next: Uint8Array | undefined = st.first;
  let leading = true;
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
    const usable = buf.length - (buf.length % FRAME_BYTES);
    carry = buf.subarray(usable);
    if (usable) yield frame(buf.subarray(0, usable));
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
 * Whole-sentence openers the negotiator starts lines with. Kept synthesized, so a line like "Thanks for
 * holding. Yoshua approved..." starts at once while the rest is still being synthesized; if the rest is
 * slow, the pause falls after a full stop, where it sounds natural. Never a one-word opener (TTS tends to
 * repeat those: "Okay, okay.") and never a clause ending in a comma (a pause there sounds broken).
 */
export const OPENERS = [
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
      await prewarm(o);
      goodOpeners.add(o);
    } catch {
      /* not cached: lines starting with it just stream */
    }
  }
}

/** A line's longest cached opener and the rest of it, or null. */
export function splitOpener(text: string): { head: string; rest: string } | null {
  const t = text.trim();
  let best: { head: string; rest: string } | null = null;
  for (const m of t.matchAll(/[.!?](?=\s+\S)/g)) {
    const end = m.index! + 1;
    if (end > 40) break;
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
export async function audioFor(text: string): Promise<ReadableStream<AudioFrame>> {
  const cached = cache.get(text);
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
    const t0 = Date.now();
    const rest = startTts(split.rest);
    rest.catch(() => undefined);
    let ctrl: AbortController | undefined;
    lastTtsInfo = `cached opener "${split.head}", rest streaming`;
    async function* joined(): AsyncGenerator<AudioFrame> {
      yield* pcmFrames(head, soundEnd(head, OPENER_TAIL_BYTES));
      let st: Awaited<typeof rest>;
      try {
        st = await rest;
      } catch (err) {
        console.error('[voice] TTS failed for the rest of a line:', (err as Error).message);
        return;
      }
      ctrl = st.ctrl;
      console.log(new Date().toISOString(), '[voice]', `rest of the line: first audio in ${Date.now() - t0} ms${st.hedged ? ' (hedged)' : ''}`);
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
