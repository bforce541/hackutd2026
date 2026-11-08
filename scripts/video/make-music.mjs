// Compose the video's background music: an original, gentle piece synthesized from scratch (no samples,
// nothing licensed), timed to design/video/timeline.json. Writes design/video/recordings/music.wav.
//
//   node scripts/video/make-music.mjs
//
// D major, 76 BPM. A soft detuned pad on a four-chord loop (Dmaj7, Bm7, Gmaj7, A6/9, two bars each),
// a quiet sub on the roots, and a felt-piano-like pluck arpeggio that comes in with the texts and
// thins out under the call. Ends on a held Dmaj9 for the logo card. The build mixes it low and ducks
// it under every voice.
import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const TL = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(ROOT, 'design/video/timeline.json'), 'utf8'));
const SR = 44100, DUR = TL.total + 1;
const N = Math.round(SR * DUR);
const L = new Float32Array(N), R = new Float32Array(N);
const at = (id) => TL.scenes.find((s) => s.id === id);

const BPM = 76, BEAT = 60 / BPM, BAR = BEAT * 4;
const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
// chords as MIDI notes (pad voicing) and their root
const CHORDS = [
  { root: 38, pad: [50, 54, 57, 61], arp: [62, 66, 69, 73, 74, 73, 69, 66] },      // Dmaj7
  { root: 35, pad: [50, 54, 57, 59], arp: [59, 62, 66, 69, 71, 69, 66, 62] },      // Bm7
  { root: 31, pad: [50, 54, 55, 59], arp: [62, 66, 67, 71, 74, 71, 67, 66] },      // Gmaj7
  { root: 33, pad: [52, 54, 57, 59], arp: [61, 64, 66, 69, 71, 69, 66, 64] },      // A6/9
];
const FINAL = { root: 38, pad: [50, 54, 57, 61, 64], arp: [] };                     // Dmaj9 to end on

// density of the pluck line over time (0 = none, 1 = every eighth)
function density(t) {
  if (t < at('texts').start - 0.5) return 0;                  // desk: pad only
  if (t < at('call').start) return 1;                          // texts: full arpeggio
  if (t < at('done').start) return 0.35;                       // call: sparse, it's under speech
  if (t < at('close').start) return 0.7;                       // dashboard
  return 0;
}

function addTone(t0, dur, f, amp, { attack = 0.01, release = 0.3, decay = 0, detune = 0, pan = 0, harm = 0.15 } = {}) {
  const i0 = Math.max(0, Math.round(t0 * SR)), i1 = Math.min(N, Math.round((t0 + dur + release) * SR));
  const gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR;
    let env = t < attack ? t / attack : 1;
    if (decay) env *= Math.exp(-(t - Math.min(t, attack)) / decay);
    if (t > dur) env *= Math.max(0, 1 - (t - dur) / release);
    const w = 2 * Math.PI * f * t;
    let s = Math.sin(w) + harm * Math.sin(2 * w + 0.3) + 0.04 * Math.sin(3 * w);
    if (detune) s = 0.5 * s + 0.5 * (Math.sin(w * (1 + detune)) + harm * Math.sin(2 * w * (1 + detune)));
    const v = s * env * amp;
    L[i] += v * gl; R[i] += v * gr;
  }
}

// seeded randomness, so every run makes the same piece
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const endAt = at('close').start + 0.4;
let bar = 0;
for (let t = 0; t < endAt; t += BAR * 2, bar++) {
  const c = CHORDS[bar % 4];
  const len = BAR * 2;
  // pad: slow swell, two detuned voices per note, spread across the stereo field
  c.pad.forEach((m, k) => addTone(t, len, midi(m), 0.055, { attack: 1.4, release: 1.8, detune: 0.0035, pan: (k / (c.pad.length - 1)) * 0.8 - 0.4, harm: 0.08 }));
  // sub on the root
  addTone(t, len, midi(c.root), 0.07, { attack: 0.8, release: 1.2, harm: 0.02 });
  // pluck arpeggio, eighth notes
  for (let e = 0; e < 16; e++) {
    const te = t + e * (BEAT / 2);
    if (te >= endAt) break;
    if (rnd() > density(te)) continue;
    const m = c.arp[e % c.arp.length];
    const vel = 0.05 * (0.75 + 0.35 * rnd()) * (e % 4 === 0 ? 1.15 : 1);
    addTone(te + (rnd() - 0.5) * 0.012, 0.05, midi(m), vel, { attack: 0.004, decay: 0.55, release: 0.8, pan: (rnd() - 0.5) * 0.6, harm: 0.25 });
  }
}
// the close: a held Dmaj9 and one last high pluck
const tc = at('close').start + 0.3;
FINAL.pad.forEach((m, k) => addTone(tc, DUR - tc - 2.2, midi(m), 0.06, { attack: 1.0, release: 2.2, detune: 0.0035, pan: k / 4 * 0.8 - 0.4, harm: 0.08 }));
addTone(tc, DUR - tc - 2.2, midi(FINAL.root), 0.07, { attack: 0.8, release: 2.2, harm: 0.02 });
[74, 78, 81, 85].forEach((m, k) => addTone(tc + 0.25 + k * BEAT / 2, 0.05, midi(m), 0.045, { attack: 0.004, decay: 0.9, release: 1.2, pan: k * 0.15 - 0.2, harm: 0.25 }));

// normalize and write a 16-bit WAV
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const g = 0.8 / (peak || 1);
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
// a soft room: two short echoes, then fade in and out
const out = path.join(ROOT, 'design/video/recordings/music.wav');
await run('ffmpeg', ['-v', 'error', '-y', '-i', dry, '-af',
  `aecho=0.85:0.6:90|170|260:0.28|0.2|0.12,lowpass=f=7000,afade=t=in:d=2.5,afade=t=out:st=${TL.total - 3}:d=3,atrim=0:${TL.total}`, out]);
console.log(`wrote ${path.relative(ROOT, out)} (${TL.total}s)`);
