// Add per-word timing and a loudness envelope to design/video/call.json, so the call screen types
// each word as it's spoken and the waveform moves with the real audio.
//
//   node scripts/video/word-times.mjs     (after align-call.mjs, or after hand-editing call.json)
//
// For each line, whisper.cpp transcribes just that stretch of out/call-cut.wav with word timestamps
// (short slices give much tighter times than one long pass). The line's own text is then laid over
// whisper's words by character position, so the words shown are always call.json's text.
// Writes line.words = [{ j, s, e }] (j = end char index in line.text, s/e = seconds in cut time)
// and CALL.env = loudness per video frame (0 to 1), then rewrites call.js.
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const VIDEO = path.join(ROOT, 'design/video');
const CUT = path.join(VIDEO, 'out/call-cut.wav');
const MODEL = process.env.WHISPER_MODEL || path.join(homedir(), 'Documents/ChatGPT/AP-animations/edit/dialogue/ggml-small.en.bin');
const FPS = 30;

const call = JSON.parse(await readFile(path.join(VIDEO, 'call.json'), 'utf8'));
const tmp = await mkdtemp(path.join(tmpdir(), 'words-'));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

for (const [k, line] of call.lines.entries()) {
  const a = Math.max(0, line.start - 0.15), b = line.end + 0.15;
  const wav = path.join(tmp, `l${k}.wav`), base = path.join(tmp, `l${k}`);
  await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(a), '-to', String(b), '-i', CUT, '-ar', '16000', '-ac', '1', wav]);
  await run('whisper-cli', ['-m', MODEL, '-f', wav, '-ml', '1', '-sow', '-oj', '-of', base], { maxBuffer: 1 << 24 }).catch(() => {});
  let ws = [];
  try {
    const j = JSON.parse(await readFile(base + '.json', 'utf8'));
    ws = j.transcription.map((s) => ({ w: norm(s.text), s: a + s.offsets.from / 1000, e: a + s.offsets.to / 1000 })).filter((x) => x.w);
  } catch {}
  // the line's own words, with their character spans
  const mine = [...line.text.matchAll(/\S+/g)].map((m) => ({ i: m.index, j: m.index + m[0].length, w: norm(m[0]) })).filter((x) => x.w);
  if (!ws.length) { line.words = null; continue; }
  // lay the line's words over whisper's by cumulative character fraction
  const wTot = ws.reduce((n, x) => n + x.w.length, 0), mTot = mine.reduce((n, x) => n + x.w.length, 0);
  const timeAt = (frac) => {
    let acc = 0;
    for (const x of ws) {
      const f0 = acc / wTot, f1 = (acc + x.w.length) / wTot;
      if (frac <= f1) return x.s + ((frac - f0) / (f1 - f0 || 1)) * (x.e - x.s);
      acc += x.w.length;
    }
    return ws[ws.length - 1].e;
  };
  let acc = 0;
  line.words = mine.map((x) => {
    const s = timeAt(acc / mTot); acc += x.w.length; const e = timeAt(acc / mTot);
    return { j: x.j, s: +Math.max(line.start, s).toFixed(3), e: +Math.min(line.end + 0.1, Math.max(s + 0.05, e)).toFixed(3) };
  });
  console.log(`${line.who.padEnd(7)} ${line.text.slice(0, 50).padEnd(50)} ${ws.length} heard / ${mine.length} shown`);
}

// loudness per frame, from the cut audio (RMS over each 1/30 s, scaled so speech peaks near 1)
const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', CUT, '-ac', '1', '-ar', '6000', '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
const pcm = new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);
const per = 6000 / FPS, env = [];
for (let f = 0; f * per < pcm.length; f++) {
  let s = 0; const n = Math.min(per, pcm.length - f * per);
  for (let i = 0; i < n; i++) { const v = pcm[f * per + i]; s += v * v; }
  env.push(Math.sqrt(s / n));
}
const sorted = [...env].sort((x, y) => x - y), p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
call.env = env.map((v) => +Math.min(1, v / p95).toFixed(3));

await writeFile(path.join(VIDEO, 'call.json'), JSON.stringify(call, null, 2) + '\n');
await writeFile(path.join(VIDEO, 'call.js'), `window.CALL = ${JSON.stringify(call)};\n`);
console.log(`wrote call.json and call.js (${call.lines.filter((l) => l.words).length}/${call.lines.length} lines word-timed, ${env.length} envelope frames)`);
