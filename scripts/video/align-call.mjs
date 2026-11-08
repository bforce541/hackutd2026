#!/usr/bin/env node
// Time the real call's transcript against the recorded audio, for the video's call screen.
//
//   node scripts/video/align-call.mjs              # cut the audio, align, write call.json + call.js
//   node scripts/video/align-call.mjs --js-only    # after hand-editing call.json: just rewrite call.js
//   node scripts/video/align-call.mjs --no-whisper # force the silence-based fallback
//
// In:  design/video/call-raw.json   (scripts/video/export-call.mjs: the server transcript, real words)
//      design/video/call-cuts.json  (the cut list: which stretches of the raw recording make the 40s)
//      design/video/recordings/call.m4a (the second phone's recording of the call)
// Out: design/video/out/call-cut.wav  the cut call audio, 48 kHz, for the edit (short fades at each cut)
//      design/video/call.json         { length, cuts, method, lines: [{ who, text, start, end }] } in CUT time
//      design/video/call.js           the same as window.CALL, for call-card.html and offer-checker.html
//
// The words on screen are always the server transcript's (what the product heard and said). Only the
// timing comes from the audio:
//   whisper  whisper.cpp (whisper-cli) transcribes the cut audio with word timestamps; the transcript's
//            words are matched to whisper's in order (edit-distance alignment, fuzzy per word, numbers
//            spelled out), and each line runs from its first matched word to its last. Lines with too
//            few matches were cut out of the audio and are dropped.
//   vad      fallback: ffmpeg silencedetect finds the speech regions of the cut audio, and the kept lines
//            are dealt into them in order. Which lines are kept comes from call-cuts.json "keep"
//            (line indices into call-raw.json) or else from the server timestamps plus "offset".
// Either way call.json is plain JSON: fix any line by hand, then run with --js-only.
// Options: --raw, --cuts, --audio, --out <dir> to use other files; --model <ggml .bin> (or WHISPER_MODEL).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const videoDir = join(root, 'design', 'video');
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

const outDir = resolve(opt('--out', videoDir));
const workDir = join(outDir, 'out');
const rawPath = resolve(opt('--raw', join(videoDir, 'call-raw.json')));
const cutsPath = resolve(opt('--cuts', join(videoDir, 'call-cuts.json')));

function writeJs(call) {
  const js = `// Written by scripts/video/align-call.mjs from call.json. Do not edit; edit call.json and run it with --js-only.\nwindow.CALL = ${JSON.stringify(call, null, 2)};\n`;
  writeFileSync(join(outDir, 'call.js'), js);
}

if (flag('--js-only')) {
  const call = JSON.parse(readFileSync(join(outDir, 'call.json'), 'utf8'));
  writeJs(call);
  console.log(`wrote ${join(outDir, 'call.js')} from call.json (${call.lines.length} lines)`);
  process.exit(0);
}

const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
const cutsDoc = JSON.parse(readFileSync(cutsPath, 'utf8'));
const cuts = cutsDoc.cuts.map((c) => ({ in: +c.in, out: +c.out }));
const audio = resolve(opt('--audio', join(videoDir, cutsDoc.source || 'recordings/call.m4a')));
const length = +cuts.reduce((s, c) => s + (c.out - c.in), 0).toFixed(3);
const want = cutsDoc.length ?? 40;
if (Math.abs(length - want) > 0.05) console.warn(`warning: cuts add up to ${length}s, the call scene is ${want}s`);
if (!existsSync(audio)) { console.error(`missing ${audio}: put the call recording there first`); process.exit(1); }
mkdirSync(workDir, { recursive: true });

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.stdout || '').slice(-800)}`);
  return r;
}

// ---- 1. cut the audio ----
const fade = cutsDoc.fade ?? 0.03;
const chains = cuts.map((c, i) => {
  const len = c.out - c.in;
  return `[0:a]atrim=start=${c.in}:end=${c.out},asetpts=PTS-STARTPTS,afade=t=in:d=${fade},afade=t=out:st=${Math.max(0, len - fade).toFixed(3)}:d=${fade}[a${i}]`;
});
const filter = `${chains.join(';')};${cuts.map((_, i) => `[a${i}]`).join('')}concat=n=${cuts.length}:v=0:a=1[cut]`;
const cutWav = join(workDir, 'call-cut.wav');
const cut16 = join(workDir, 'call-cut-16k.wav');
run('ffmpeg', ['-y', '-loglevel', 'error', '-i', audio, '-filter_complex', filter, '-map', '[cut]', '-ar', '48000', cutWav]);
run('ffmpeg', ['-y', '-loglevel', 'error', '-i', cutWav, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', cut16]);

// ---- text helpers ----
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function numWords(n) {
  if (n < 20) return [ONES[n]];
  if (n < 100) return n % 10 ? [TENS[Math.floor(n / 10)], ONES[n % 10]] : [TENS[n / 10]];
  if (n < 1000) return [ONES[Math.floor(n / 100)], 'hundred', ...(n % 100 ? numWords(n % 100) : [])];
  return String(n).split('').map((d) => ONES[+d]);
}
function tokens(text) {
  return String(text).toLowerCase()
    .replace(/[’']/g, '')
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .replace(/([a-z])(\d)|(\d)([a-z])/g, (m, a, b, c, d) => (a ? `${a} ${b}` : `${c} ${d}`))
    .replace(/([a-z])(\d)|(\d)([a-z])/g, (m, a, b, c, d) => (a ? `${a} ${b}` : `${c} ${d}`))
    .split(/[^a-z0-9]+/).filter(Boolean)
    .flatMap((w) => (/^\d+$/.test(w) ? numWords(+w) : [w]));
}
function lev(a, b) {
  const m = a.length, n = b.length; if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const sim = (a, b) => (a === b ? 1 : 1 - lev(a, b) / Math.max(a.length, b.length));

// ---- 2a. whisper ----
function findModel() {
  const cands = [opt('--model'), process.env.WHISPER_MODEL,
    join(videoDir, 'models', 'ggml-small.en.bin'), join(videoDir, 'models', 'ggml-base.en.bin'),
    join(homedir(), 'Documents/ChatGPT/AP-animations/edit/dialogue/ggml-small.en.bin'),
    join(homedir(), 'Documents/ChatGPT/AP-animations/edit/dialogue/ggml-base.en.bin'),
    '/opt/homebrew/share/whisper-cpp/ggml-small.en.bin', '/opt/homebrew/share/whisper-cpp/ggml-base.en.bin'];
  return cands.find((p) => p && existsSync(p));
}
function haveWhisper() { return spawnSync('which', ['whisper-cli']).status === 0; }

function whisperWords(model) {
  const base = join(workDir, 'call-whisper');
  run('whisper-cli', ['-m', model, '-f', cut16, '-l', 'en', '-ml', '1', '-sow', '-oj', '-of', base, '-np']);
  const j = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
  const words = [];
  for (const seg of j.transcription ?? []) {
    const from = seg.offsets.from / 1000, to = seg.offsets.to / 1000;
    const toks = tokens(seg.text);
    toks.forEach((tok, k) => {
      const a = from + ((to - from) * k) / toks.length, b = from + ((to - from) * (k + 1)) / toks.length;
      words.push({ tok, from: a, to: b });
    });
  }
  return words;
}

function alignWhisper(lines, words) {
  // A = transcript tokens (with their line), B = whisper words; global edit-distance alignment
  const A = [];
  lines.forEach((l, li) => tokens(l.text).forEach((tok) => A.push({ tok, li })));
  const n = A.length, m = words.length, GAP = 1;
  const subCost = (i, j) => { const s = sim(A[i].tok, words[j].tok); return s >= 0.75 ? (1 - s) * 0.5 : 1.6; };
  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = 1; i <= n; i++) D[i][0] = i * GAP;
  for (let j = 1; j <= m; j++) D[0][j] = j * GAP;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    D[i][j] = Math.min(D[i - 1][j - 1] + subCost(i - 1, j - 1), D[i - 1][j] + GAP, D[i][j - 1] + GAP);
  }
  const hit = new Array(n).fill(-1);
  for (let i = n, j = m; i > 0 && j > 0;) {
    const c = subCost(i - 1, j - 1);
    if (Math.abs(D[i][j] - (D[i - 1][j - 1] + c)) < 1e-9) { if (c < 1) hit[i - 1] = j - 1; i--; j--; }
    else if (Math.abs(D[i][j] - (D[i - 1][j] + GAP)) < 1e-9) i--;
    else j--;
  }
  const out = [], dropped = [];
  lines.forEach((l, li) => {
    const idx = A.map((a, k) => (a.li === li && hit[k] >= 0 ? hit[k] : -1)).filter((x) => x >= 0);
    const total = A.filter((a) => a.li === li).length;
    if (!idx.length || idx.length < Math.max(1, Math.ceil(total * 0.4))) { dropped.push(l.text); return; }
    out.push({ who: l.who, text: l.text, start: words[Math.min(...idx)].from, end: words[Math.max(...idx)].to });
  });
  return { lines: out, dropped };
}

// ---- 2b. silence-based fallback ----
function speechRegions() {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', cutWav, '-af', 'silencedetect=noise=-32dB:d=0.35', '-f', 'null', '-'], { encoding: 'utf8' });
  const log = r.stderr || '';
  const sil = [];
  for (const m of log.matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g)) sil.push([+m[1], +m[2]]);
  const regions = [];
  let cur = 0;
  for (const [s, e] of sil) { if (s - cur > 0.25) regions.push([cur, s]); cur = e; }
  if (length - cur > 0.25) regions.push([cur, length]);
  return regions;
}

function alignVad(lines) {
  let kept;
  if (Array.isArray(cutsDoc.keep)) kept = cutsDoc.keep.map((i) => lines[i]).filter(Boolean);
  else {
    // a line is in the cut audio if its server time (it arrives as the speaker finishes) lands in a cut
    const offset = cutsDoc.offset ?? 0;
    kept = lines.filter((l) => cuts.some((c) => l.at + offset >= c.in - 0.5 && l.at + offset <= c.out + 1.5));
    console.warn(`vad: kept ${kept.length}/${lines.length} lines by server time (offset ${offset}s). Check them, or set "keep" in call-cuts.json.`);
  }
  let regions = speechRegions();
  if (!regions.length) regions = [[0, length]];
  // as many regions as lines: merge across the smallest gaps, or split the longest regions
  while (regions.length > kept.length && regions.length > 1) {
    let k = 0, best = Infinity;
    for (let i = 0; i + 1 < regions.length; i++) { const g = regions[i + 1][0] - regions[i][1]; if (g < best) { best = g; k = i; } }
    regions.splice(k, 2, [regions[k][0], regions[k + 1][1]]);
  }
  while (regions.length < kept.length) {
    let k = 0; regions.forEach((r, i) => { if (r[1] - r[0] > regions[k][1] - regions[k][0]) k = i; });
    const [s, e] = regions[k], mid = (s + e) / 2;
    regions.splice(k, 1, [s, mid - 0.05], [mid + 0.05, e]);
  }
  return { lines: kept.map((l, i) => ({ who: l.who, text: l.text, start: regions[i][0], end: regions[i][1] })), dropped: lines.filter((l) => !kept.includes(l)).map((l) => l.text) };
}

// ---- 3. align and write ----
let method = 'vad', model = null, result;
if (!flag('--no-whisper') && haveWhisper() && (model = findModel())) {
  try {
    const words = whisperWords(model);
    result = alignWhisper(raw.lines, words);
    method = 'whisper';
    if (result.lines.length < Math.min(3, raw.lines.length)) throw new Error(`only ${result.lines.length} lines matched`);
  } catch (err) {
    console.warn(`whisper alignment failed (${err.message}); falling back to silence detection`);
    result = null; method = 'vad'; model = null;
  }
}
if (!result) result = alignVad(raw.lines);

// whisper's word ends run into the silence after them: snap each line's edges to the speech regions
// it overlaps, but only by a little (a noisy room can make one long region; then nothing moves)
if (method === 'whisper') {
  const regions = speechRegions();
  result.lines.forEach((l) => {
    const R = regions.filter((r) => r[1] > l.start && r[0] < l.end);
    if (!R.length) return;
    const s = R[0][0], e = R[R.length - 1][1];
    if (Math.abs(s - l.start) < 0.8) l.start = s;
    if (e < l.end && l.end - e < 1.5) l.end = e;
  });
}

// tidy: in order, no overlaps, inside the call
const lines = result.lines.sort((a, b) => a.start - b.start).map((l) => ({ ...l, start: Math.max(0, l.start - 0.05), end: Math.min(length, l.end + 0.1) }));
for (let i = 1; i < lines.length; i++) if (lines[i].start < lines[i - 1].end) lines[i - 1].end = Math.max(lines[i - 1].start + 0.2, lines[i].start - 0.05);
lines.forEach((l) => { l.start = +l.start.toFixed(2); l.end = +l.end.toFixed(2); });

const call = {
  placeholder: false,
  length,
  cuts,
  method,
  ...(model ? { model: model.split('/').pop() } : {}),
  audio: 'out/call-cut.wav',
  callId: raw.callId ?? null,
  lines,
  dropped: result.dropped,
};
writeFileSync(join(outDir, 'call.json'), JSON.stringify(call, null, 2) + '\n');
writeJs(call);
console.log(`${method}${model ? ` (${call.model})` : ''}: ${lines.length} lines timed, ${result.dropped.length} cut out, ${length}s`);
for (const l of lines) console.log(`  ${l.start.toFixed(2).padStart(6)}–${l.end.toFixed(2).padEnd(6)} ${l.who.padEnd(7)} ${l.text}`);
if (result.dropped.length) console.log(`  cut out: ${result.dropped.map((t) => JSON.stringify(t.slice(0, 40))).join(', ')}`);
console.log(`wrote ${join(outDir, 'call.json')}, call.js, ${cutWav}`);
