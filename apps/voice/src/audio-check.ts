/**
 * Quality checks for one synthesized line (PCM16 mono 24 kHz), so a glitched clip is never played to
 * the caller. Implemented by: voice. Pure functions, cheap (~5 ms for a 5 s clip), shared with the
 * test harness (scripts/voice-test) which runs the same measurements on the audio the caller heard.
 *
 * What a bad clip looks like, and the measure that catches it:
 *  - doubled / restarted / rambling speech ("Got it, got it.", a line said twice): far more seconds of
 *    sound than its words take -> `secPerWord` too high;
 *  - cut short (TTS stopped mid-line): too few seconds for its words -> `secPerWord` too low;
 *  - a noticeably deeper (or squeaky) voice: median pitch of the voiced frames outside marin's range
 *    -> `f0`;
 *  - static / a burst of noise: a long run of loud frames with no pitch and many zero crossings ->
 *    `noiseMs`; samples pinned at full scale -> `clipPct`.
 * The limits come from measuring ~20 normal marin lines (scripts/voice-test/marin-baseline.mts).
 */
export const PCM_RATE = 24_000;

export interface ClipStats {
  /** Seconds from the first to the last audible sample. */
  soundSec: number;
  words: number;
  secPerWord: number;
  /** Median F0 (Hz) over voiced 40 ms frames, 0 if none were voiced. */
  f0: number;
  voicedFrames: number;
  /** Peak |sample| and the share of samples at (nearly) full scale, in percent. */
  peak: number;
  clipPct: number;
  /** RMS of the loud frames (speech level). */
  rms: number;
  /** Longest run of loud, unpitched, hissy frames (ms): noise, not a fricative. */
  noiseMs: number;
}

/**
 * marin's normal ranges, measured on 100 clips of 20 lines (scripts/voice-test/marin-baseline.mts,
 * Nov 8): median pitch 174-242 Hz (one deep take at 136 Hz; fillers like "Sure, so..." run to ~300 Hz), 0.22-0.60 s of sound per word for real
 * lines, speech RMS 2400-4250, no clipping, hiss runs up to 240 ms (fricatives). Outliers TTS made:
 * "Mm-hm..." 2.6 s and 3.7 s, "Uh, one sec..." 2.8 s, "Okay, let me see..." 3.9 s, "Got it." 6.1 s.
 * Limits sit outside the normal spread with margin, so a clean clip is (almost) never re-synthesized.
 */
export const LIMITS = {
  f0Min: 160,
  f0Max: 320,
  /** Seconds of sound per word, plus a fixed slack (a short line has a pause around one word). */
  maxSecPerWord: 0.62,
  slackSec: 0.6,
  minSecPerWord: 0.15,
  maxClipPct: 0.05,
  maxNoiseMs: 400,
  minRms: 900,
};

const LOUD = 400;

export function wordCount(text: string): number {
  // A spelled reference ("K, 7, Q, 2") is one word per character; "$20" is a couple of words when said.
  return text
    .replace(/\$(\d+)/g, '$1 dollars')
    .split(/[\s,]+/)
    .filter((w) => /[a-z0-9]/i.test(w)).length;
}

/** Samples of a PCM16 little-endian byte buffer (copied, aligned). */
export function samplesOf(pcm: Uint8Array): Int16Array {
  const copy = new Uint8Array(pcm.length & ~1);
  copy.set(pcm.subarray(0, copy.length));
  return new Int16Array(copy.buffer);
}

export function clipStats(s: Int16Array, text: string, rate = PCM_RATE): ClipStats {
  const words = Math.max(1, wordCount(text));
  // Sound span.
  let first = -1;
  let last = -1;
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < s.length; i++) {
    const a = Math.abs(s[i]!);
    if (a > peak) peak = a;
    if (a >= 32_000) clipped++;
    if (a >= LOUD) {
      if (first < 0) first = i;
      last = i;
    }
  }
  const soundSec = first < 0 ? 0 : (last - first + 1) / rate;

  // Downsample to 8 kHz (box filter) for pitch: F0 of speech is well under 1 kHz.
  const step = Math.max(1, Math.round(rate / 8000));
  const r8 = rate / step;
  const n8 = Math.floor(s.length / step);
  const x = new Float32Array(n8);
  for (let i = 0; i < n8; i++) {
    let acc = 0;
    for (let k = 0; k < step; k++) acc += s[i * step + k]!;
    x[i] = acc / step;
  }
  const win = Math.round(r8 * 0.04); // 40 ms
  const hop = Math.round(r8 * 0.02); // 20 ms
  const minLag = Math.floor(r8 / 400);
  const maxLag = Math.ceil(r8 / 70);
  const f0s: number[] = [];
  let loudSq = 0;
  let loudN = 0;
  let run = 0;
  let noiseFrames = 0;
  // Zero crossings per 20 ms at the full rate (hiss crosses far more often than voiced speech).
  const zcr = (from: number, len: number) => {
    let z = 0;
    for (let i = from + 1; i < Math.min(s.length, from + len); i++) if ((s[i]! >= 0) !== (s[i - 1]! >= 0)) z++;
    return z / len;
  };
  for (let off = 0; off + win + maxLag < n8; off += hop) {
    let e = 0;
    let mean = 0;
    for (let i = 0; i < win; i++) mean += x[off + i]!;
    mean /= win;
    for (let i = 0; i < win; i++) {
      const v = x[off + i]! - mean;
      e += v * v;
    }
    const frameRms = Math.sqrt(e / win);
    const loud = frameRms >= LOUD;
    let best = 0;
    let bestLag = 0;
    if (loud) {
      loudSq += e;
      loudN += win;
      for (let lag = minLag; lag <= maxLag; lag++) {
        let c = 0;
        let e2 = 0;
        for (let i = 0; i < win; i++) {
          const a = x[off + i]! - mean;
          const b = x[off + i + lag]! - mean;
          c += a * b;
          e2 += b * b;
        }
        const r = c / Math.sqrt(e * e2 + 1e-9);
        if (r > best) {
          best = r;
          bestLag = lag;
        }
      }
    }
    if (loud && best >= 0.6) {
      // Parabolic refinement isn't worth it here: a ~2% step at 200 Hz is plenty for a range check.
      f0s.push(r8 / bestLag);
    }
    const hiss = loud && best < 0.4 && zcr(off * step, win * step) > 0.25;
    run = hiss ? run + 1 : 0;
    if (run > noiseFrames) noiseFrames = run;
  }
  f0s.sort((a, b) => a - b);
  const f0 = f0s.length ? f0s[Math.floor(f0s.length / 2)]! : 0;
  return {
    soundSec,
    words,
    secPerWord: soundSec / words,
    f0: Math.round(f0),
    voicedFrames: f0s.length,
    peak,
    clipPct: (clipped / Math.max(1, s.length)) * 100,
    rms: Math.round(loudN ? Math.sqrt(loudSq / loudN) : 0),
    // Frames overlap by half: a run of n frames covers ~ (n + 1) * 20 ms.
    noiseMs: noiseFrames ? (noiseFrames + 1) * 20 : 0,
  };
}

/** Problems with a clip (empty when it is fine to play). */
export function clipProblems(st: ClipStats, limits = LIMITS): string[] {
  const out: string[] = [];
  if (st.soundSec <= 0.05) return ['no sound'];
  if (st.soundSec > limits.slackSec + st.words * limits.maxSecPerWord) out.push(`too long (${st.soundSec.toFixed(2)} s for ${st.words} words)`);
  if (st.words >= 4 && st.secPerWord < limits.minSecPerWord) out.push(`too short (${st.soundSec.toFixed(2)} s for ${st.words} words)`);
  // Pitch needs enough voiced frames to mean anything (a "Mm-hm…" has few).
  if (st.voicedFrames >= 8 && (st.f0 < limits.f0Min || st.f0 > limits.f0Max)) out.push(`pitch ${st.f0} Hz outside ${limits.f0Min}-${limits.f0Max}`);
  if (st.clipPct > limits.maxClipPct) out.push(`clipping ${st.clipPct.toFixed(2)}%`);
  if (st.noiseMs > limits.maxNoiseMs) out.push(`noise run ${st.noiseMs} ms`);
  if (st.rms < limits.minRms) out.push(`too quiet (rms ${st.rms})`);
  return out;
}

/** Lower is better: how far outside the limits a clip is (used to keep the best of several tries). */
export function clipBadness(st: ClipStats, limits = LIMITS): number {
  let b = 0;
  const over = st.soundSec - (limits.slackSec + st.words * limits.maxSecPerWord);
  if (over > 0) b += over * 2;
  if (st.words >= 4) b += Math.max(0, limits.minSecPerWord * st.words - st.soundSec) * 2;
  if (st.voicedFrames >= 8) b += Math.max(0, limits.f0Min - st.f0, st.f0 - limits.f0Max) / 10;
  b += Math.max(0, st.clipPct - limits.maxClipPct) * 20;
  b += Math.max(0, st.noiseMs - limits.maxNoiseMs) / 100;
  if (st.soundSec <= 0.05) b += 100;
  return b;
}
