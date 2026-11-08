// Compose the video's music: an original, upbeat pitch-video track synthesized from scratch (no samples,
// nothing licensed), arranged to design/video/timeline.json. Writes design/video/recordings/music.wav.
//
//   node scripts/video/make-music.mjs
//
// D major, about 116 BPM, tempo set so the drop lands exactly on the dashboard (the "whatitis" scene).
// I–V–vi–IV (D, A, Bm, G), one bar each. Four-on-the-floor kick, claps on 2 and 4, offbeat hats,
// a pumping supersaw pad, offbeat chord stabs, a driving eighth-note bass, and a short pluck hook.
// Arrangement: light intro under the desk, groove in on the texts, pulled back under the call,
// a riser into the dashboard, the full drop under the voiceovers, a final hit on the logo.
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const TL = JSON.parse(await readFile(path.join(ROOT, 'design/video/timeline.json'), 'utf8'));
const at = (id) => TL.scenes.find((s) => s.id === id);
const SR = 44100, DUR = TL.total + 1, N = Math.round(SR * DUR);
const L = new Float32Array(N), R = new Float32Array(N);

const DROP = at('whatitis').start;                 // 66s
const BAR = DROP / Math.round(DROP / 2.07);        // ~116 BPM, drop on a downbeat
const BEAT = BAR / 4, E8 = BEAT / 2, S16 = BEAT / 4;
const T = { texts: at('texts').start, call: at('call').start, done: at('done').start, close: at('close').start };
const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);

// D, A, Bm, G
const PROG = [
  { root: 38, tri: [62, 66, 69], hook: [78, 81, 78, 76] },
  { root: 33, tri: [61, 64, 69], hook: [76, 73, 76, 81] },
  { root: 35, tri: [62, 66, 71], hook: [74, 78, 74, 73] },
  { root: 31, tri: [62, 67, 71], hook: [71, 74, 79, 78] },
];

// how much of each part plays at time t (0 to 1)
function mixAt(t) {
  if (t < T.texts) return { kick: 0, clap: 0, hat: 0.5, bass: 0, pad: 0.55, stab: 0, hook: 0 };          // desk: light intro
  if (t < T.call) return { kick: 1, clap: 0.8, hat: 1, bass: 0.9, pad: 0.8, stab: 0.8, hook: 0 };        // texts: groove
  if (t < T.done) return { kick: 0.7, clap: 0, hat: 0.7, bass: 0.7, pad: 0.6, stab: 0.4, hook: 0 };      // call: pulled back
  if (t < DROP) return { kick: 0, clap: 0, hat: 0.6, bass: 0, pad: 0.7, stab: 0, hook: 0 };              // build
  if (t < T.close) return { kick: 1, clap: 1, hat: 1, bass: 1, pad: 0.9, stab: 0.9, hook: 0.8 };         // drop
  return { kick: 0, clap: 0, hat: 0, bass: 0, pad: 0, stab: 0, hook: 0 };                                // close: final hit only
}

let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function add(i, v, pan = 0) {
  if (i < 0 || i >= N) return;
  const gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
  L[i] += v * gl; R[i] += v * gr;
}

// band-limited saw (polyBLEP)
function saw(phase, dt) {
  let v = 2 * phase - 1;
  if (phase < dt) { const x = phase / dt; v -= x + x - x * x - 1; }
  else if (phase > 1 - dt) { const x = (phase - 1) / dt; v -= x * x + x + x + 1; }
  return v;
}

/** A synth voice: detuned saws through a one-pole lowpass with an envelope. */
function synth(t0, dur, f, amp, { voices = 3, detune = 0.006, cut = 2000, cutEnv = 0, attack = 0.005, decay = 0, release = 0.12, pan = 0, pump = false, sub = 0 } = {}) {
  const i0 = Math.round(t0 * SR), len = Math.round((dur + release) * SR);
  const ph = Array.from({ length: voices }, () => rnd()), fs = Array.from({ length: voices }, (_, k) => f * (1 + detune * (k - (voices - 1) / 2)));
  let lp = 0, sp = 0;
  for (let n = 0; n < len; n++) {
    const t = n / SR;
    let env = t < attack ? t / attack : 1;
    if (decay) env *= Math.exp(-(t - Math.min(t, attack)) / decay);
    if (t > dur) env *= Math.max(0, 1 - (t - dur) / release);
    let s = 0;
    for (let k = 0; k < voices; k++) { const dt = fs[k] / SR; ph[k] = (ph[k] + dt) % 1; s += saw(ph[k], dt); }
    s /= voices;
    const c = Math.min(0.99, (2 * Math.PI * (cut + cutEnv * Math.exp(-t / 0.08))) / SR);
    lp += c * (s - lp);
    let v = lp;
    if (sub) { sp += (2 * Math.PI * f) / SR; v += sub * Math.sin(sp * 0.5); }
    let g = env * amp;
    if (pump) { const tt = t0 + t, sinceBeat = ((tt % BEAT) + BEAT) % BEAT; g *= 1 - 0.65 * Math.exp(-sinceBeat / 0.11); }
    add(i0 + n, v * g, pan);
  }
}

function kick(t0, amp) {
  const i0 = Math.round(t0 * SR), len = Math.round(0.45 * SR);
  let p = 0;
  for (let n = 0; n < len; n++) {
    const t = n / SR, f = 48 + 110 * Math.exp(-t / 0.035);
    p += (2 * Math.PI * f) / SR;
    const v = Math.sin(p) * Math.exp(-t / 0.16) + 0.25 * (rnd() * 2 - 1) * Math.exp(-t / 0.003);
    add(i0 + n, Math.tanh(1.6 * v) * amp);
  }
}
function noiseHit(t0, amp, { decay = 0.05, hp = 0.6, pan = 0, len = 0.3, bursts = 1 } = {}) {
  const i0 = Math.round(t0 * SR), n1 = Math.round(len * SR);
  let prev = 0, hpv = 0;
  for (let n = 0; n < n1; n++) {
    const t = n / SR;
    let env = Math.exp(-t / decay);
    if (bursts > 1) env = Math.max(...Array.from({ length: bursts }, (_, b) => (t >= b * 0.011 ? Math.exp(-(t - b * 0.011) / (b === bursts - 1 ? decay : 0.006)) : 0)));
    const w = rnd() * 2 - 1;
    hpv = hp * (hpv + w - prev); prev = w;      // simple highpass
    add(i0 + n, hpv * env * amp, pan);
  }
}
const clap = (t0, a) => noiseHit(t0, a, { decay: 0.09, hp: 0.85, bursts: 3, len: 0.35 });
const hat = (t0, a, open = false) => noiseHit(t0, a, { decay: open ? 0.07 : 0.022, hp: 0.97, pan: 0.25, len: open ? 0.25 : 0.08 });

// ---- the arrangement ----
const end = T.close;
const nBars = Math.ceil(end / BAR);
for (let b = 0; b < nBars; b++) {
  const t = b * BAR, c = PROG[b % 4];
  if (t >= end) break;
  const m = mixAt(t + 0.01);
  // pad: pumping supersaw triad, an octave down plus the octave
  if (m.pad) c.tri.forEach((n, k) => synth(t, BAR, midi(n - 12), 0.05 * m.pad, { voices: 5, detune: 0.012, cut: t < DROP ? 1200 + 1800 * Math.min(1, Math.max(0, (t - (T.done)) / (DROP - T.done))) * (t >= T.done ? 1 : 0) + (t < T.done ? 900 : 0) : 2600, attack: 0.03, release: 0.25, pan: (k - 1) * 0.5, pump: true }));
  for (let e = 0; e < 8; e++) {
    const te = t + e * E8;
    if (te >= end) break;
    const mm = mixAt(te);
    // bass: eighths, root with an octave jump on the offbeats
    if (mm.bass) synth(te, E8 * 0.8, midi(c.root + (e % 2 ? 12 : 0)), 0.16 * mm.bass, { voices: 2, detune: 0.004, cut: 420, cutEnv: 900, decay: 0.12, release: 0.04, sub: 0.6 });
    // offbeat chord stabs
    if (mm.stab && e % 2) c.tri.forEach((n, k) => synth(te, 0.06, midi(n), 0.035 * mm.stab, { voices: 3, detune: 0.008, cut: 2600, cutEnv: 2500, decay: 0.07, release: 0.06, pan: (k - 1) * 0.6 }));
    // hats: offbeat open, light closed sixteenths in the full sections
    if (mm.hat) {
      if (e % 2) hat(te, 0.11 * mm.hat, true);
      if (mm.kick >= 1) { hat(te, 0.05 * mm.hat); hat(te + S16, 0.035 * mm.hat); }
    }
  }
  for (let q = 0; q < 4; q++) {
    const tq = t + q * BEAT;
    if (tq >= end) break;
    const mq = mixAt(tq);
    if (mq.kick) kick(tq, 0.55 * mq.kick);
    if (mq.clap && (q === 1 || q === 3)) clap(tq, 0.26 * mq.clap);
    // hook: a pluck on each beat in the drop
    if (mq.hook) synth(tq, BEAT * 0.5, midi(c.hook[q]), 0.05 * mq.hook, { voices: 2, detune: 0.004, cut: 1800, cutEnv: 4000, decay: 0.16, release: 0.1, pan: 0.15 });
  }
}

// riser into the drop: rising filtered noise and a snare roll over the last bars before the dashboard
{
  const r0 = DROP - BAR * 2, i0 = Math.round(r0 * SR), len = Math.round((DROP - r0) * SR);
  let prev = 0, hpv = 0;
  for (let n = 0; n < len; n++) {
    const p = n / len, w = rnd() * 2 - 1, hp = 0.6 + 0.38 * p;
    hpv = hp * (hpv + w - prev); prev = w;
    add(i0 + n, hpv * 0.12 * p * p, Math.sin(n / SR * 3) * 0.3);
  }
  const steps = [[r0, E8], [DROP - BAR, S16], [DROP - BEAT, S16 / 2]];
  for (const [s, step] of steps) for (let t = s; t < Math.min(DROP, s + (s === r0 ? BAR : DROP - s)); t += step) noiseHit(t, 0.06 + 0.12 * ((t - r0) / (DROP - r0)), { decay: 0.05, hp: 0.8, len: 0.12 });
}
// a crash on the drop
noiseHit(DROP, 0.16, { decay: 0.9, hp: 0.93, len: 2.5, pan: -0.2 });

// final hit on the logo: kick, crash, the D chord ringing out
kick(T.close, 0.6);
noiseHit(T.close, 0.18, { decay: 1.2, hp: 0.93, len: 3.5 });
[50, 57, 62, 66, 69, 74].forEach((n, k) => synth(T.close, DUR - T.close - 2.5, midi(n), 0.045, { voices: 5, detune: 0.01, cut: 2400, attack: 0.01, release: 2.4, pan: (k / 5) * 1.2 - 0.6 }));
synth(T.close, 1.2, midi(38), 0.18, { voices: 2, cut: 300, decay: 0.8, release: 1, sub: 0.7 });

// soft clip, normalize, write a 16-bit WAV
let peak = 0;
for (let i = 0; i < N; i++) { L[i] = Math.tanh(L[i] * 1.2); R[i] = Math.tanh(R[i] * 1.2); peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
const g = 0.9 / (peak || 1);
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVEfmt ', 8);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * g)) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * g)) * 32767), 46 + i * 4);
}
const dry = path.join(ROOT, 'design/video/out/music-dry.wav');
await writeFile(dry, buf);
// a little room, gentle glue compression, loudness to -18 LUFS so the mix level in timeline.json is predictable
const out = path.join(ROOT, 'design/video/recordings/music.wav');
await run('ffmpeg', ['-v', 'error', '-y', '-i', dry, '-af',
  `aecho=0.9:0.5:45|95:0.18|0.1,acompressor=threshold=0.25:ratio=2.5:attack=8:release=120,afade=t=in:d=1.2,afade=t=out:st=${TL.total - 2.5}:d=2.5,atrim=0:${TL.total},loudnorm=I=-18:TP=-1.5:LRA=9`, '-ar', '48000', out]);
console.log(`wrote ${path.relative(ROOT, out)} (${TL.total}s, ${(240 / BAR).toFixed(1)} BPM, drop at ${DROP}s)`);
