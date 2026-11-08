/**
 * Bake the fixed lines: synthesizes every filler and fixed line of a call several times (same settings
 * as apps/voice/src/speech.ts), checks each take (apps/voice/src/audio-check.ts), and keeps the clean
 * take nearest marin's usual pitch (205 Hz) and pace. Writes apps/voice/clips/<hash>.pcm (PCM16 mono
 * 24 kHz, trimmed as played) and clips/manifest.json; the worker loads them at start, so these lines
 * play instantly and sound the same on every call. No calls, no texts.
 *
 *   npx @dotenvx/dotenvx run --convention=nextjs -q -- apps/server/node_modules/.bin/tsx \
 *     scripts/voice-test/bake-clips.mts [takes=6] [--only-missing]
 * Re-run after changing a fixed line's wording (a line with no baked clip is synthesized live, slower).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CLIPS_DIR, TARGET_F0, TTS_INSTRUCTIONS, TTS_MODEL, TTS_VOICE, trimmed, ttsText, type BakedManifest } from '../../apps/voice/src/speech.ts';
import { clipProblems, clipStats, samplesOf } from '../../apps/voice/src/audio-check.ts';
import { FILLERS, holdUpdates, INBOUND_FIRST_FILLERS, INBOUND_FIXED_LINES, INBOUND_IDLE_GOODBYE, INBOUND_SECOND_FILLERS, likelyLines, LOST_PLACE_LINE } from '../../apps/voice/src/conductor.ts';

const TAKES = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 6);
const ONLY_MISSING = process.argv.includes('--only-missing');
const FILLER_TEXTS = [...new Set([...FILLERS.map((f) => f.text), ...INBOUND_FIRST_FILLERS, ...INBOUND_SECOND_FILLERS])];
/** Inbound first fillers must be short. */
const SHORT_FILLERS = new Set(INBOUND_FIRST_FILLERS.map(ttsText));
const LINES = [
  ...FILLER_TEXTS,
  ...INBOUND_FIXED_LINES,
  INBOUND_IDLE_GOODBYE,
  ...likelyLines('Yoshua').slice(0, 4),
  ...holdUpdates('Yoshua'),
  LOST_PLACE_LINE,
  'Sorry, could you say that again?',
];

async function tts(text: string): Promise<Uint8Array> {
  for (let i = 0; ; i++) {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, instructions: TTS_INSTRUCTIONS, response_format: 'pcm' }),
    });
    if (r.ok) return new Uint8Array(await r.arrayBuffer());
    if (i >= 3) throw new Error(`TTS ${r.status}`);
    await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
  }
}

/** What a take says (re-transcribed), to make sure it says the words: "PacePay" not "Kaste". */
async function heard(pcm: Uint8Array): Promise<string> {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24_000, 24);
  h.writeUInt32LE(48_000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  const fd = new FormData();
  fd.append('file', new Blob([h, Buffer.from(pcm)], { type: 'audio/wav' }), 'take.wav');
  fd.append('model', 'gpt-4o-transcribe');
  fd.append('prompt', 'PacePay, a money assistant, talking to Yoshua.');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: fd });
  return r.ok ? (((await r.json()) as { text?: string }).text ?? '') : '';
}
const wordsOf = (s: string) => s.toLowerCase().replace(/pace ?pay/g, 'pacepay').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
/** The take says the line: (nearly) every word, and "PacePay" when the line has it. Names and fillers are not checked. */
function saysIt(text: string, said: string): boolean {
  const want = wordsOf(text.replace(/Yaw-shoo-uh'?s?/g, '')).filter((w) => w.length > 2);
  const got = new Set(wordsOf(said));
  if (/PacePay/.test(text) && !got.has('pacepay')) return false;
  return !want.length || want.filter((w) => got.has(w)).length / want.length >= 0.85;
}

mkdirSync(CLIPS_DIR, { recursive: true });
let old: BakedManifest | undefined;
try {
  old = JSON.parse(readFileSync(join(CLIPS_DIR, 'manifest.json'), 'utf8'));
} catch {
  /* first bake */
}
const keep = new Map((ONLY_MISSING && old?.model === TTS_MODEL ? old.clips : []).map((c) => [c.text, c]));
const out: BakedManifest = { model: TTS_MODEL, voice: TTS_VOICE, clips: [] };
const texts = [...new Set(LINES.map(ttsText))];
let next = 0;
const rows: string[] = [];
async function worker() {
  for (let i = next++; i < texts.length; i = next++) {
    const text = texts[i]!;
    const have = keep.get(text);
    if (have) {
      out.clips.push(have);
      continue;
    }
    const filler = FILLER_TEXTS.map(ttsText).includes(text);
    const n = SHORT_FILLERS.has(text) ? TAKES + 6 : filler ? TAKES + 2 : TAKES;
    const takes = await Promise.all(
      Array.from({ length: n }, async () => {
        try {
          const pcm = await tts(text);
          const st = clipStats(samplesOf(pcm), text);
          return { pcm, st, problems: clipProblems(st) };
        } catch {
          return undefined;
        }
      }),
    );
    const clean = takes.filter((t): t is NonNullable<typeof t> => !!t && !t.problems.length && (!SHORT_FILLERS.has(text) || t.st.soundSec <= 0.7));
    // Nearest the usual pitch; then a natural pace (fillers: short and light, lines: ~0.37 s a word).
    const score = (t: (typeof clean)[number]) =>
      (t.st.voicedFrames >= 8 ? Math.abs(t.st.f0 - TARGET_F0) / 10 : 1) + (filler ? Math.max(0, t.st.soundSec - 0.9) * 3 : Math.abs(t.st.secPerWord - 0.37) / 0.08);
    clean.sort((a, b) => score(a) - score(b));
    // The best-scored take that also SAYS the line (checked by ear, i.e. re-transcribed).
    let best: (typeof clean)[number] | undefined;
    let said = '';
    for (const t of clean.slice(0, filler ? 2 : 5)) {
      said = await heard(trimmed(t.pcm));
      if (filler || saysIt(text, said)) {
        best = t;
        break;
      }
    }
    if (!best) {
      rows.push(`  NONE CLEAN (${takes.filter(Boolean).length} takes, ${clean.length} passed the check; last heard "${said}") | ${text}`);
      continue;
    }
    const file = `${createHash('sha1').update(text).digest('hex').slice(0, 16)}.pcm`;
    const pcm = trimmed(best.pcm);
    writeFileSync(join(CLIPS_DIR, file), pcm);
    out.clips.push({ text, file, f0: best.st.f0, soundSec: Number(best.st.soundSec.toFixed(2)) });
    rows.push(`  ${String(best.st.f0).padStart(4)} Hz ${best.st.soundSec.toFixed(2).padStart(5)} s ${clean.length}/${n} clean | ${text}\n      heard: ${said}`);
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
// Order as listed (stable diffs), and drop files no line uses any more.
out.clips.sort((a, b) => texts.indexOf(a.text) - texts.indexOf(b.text));
writeFileSync(join(CLIPS_DIR, 'manifest.json'), JSON.stringify(out, null, 1) + '\n');
const used = new Set(out.clips.map((c) => c.file));
for (const f of readdirSync(CLIPS_DIR)) if (f.endsWith('.pcm') && !used.has(f)) rmSync(join(CLIPS_DIR, f));
console.log(rows.join('\n'));
const bytes = out.clips.reduce((n, c) => n + readFileSync(join(CLIPS_DIR, c.file)).length, 0);
console.log(`baked ${out.clips.length}/${texts.length} lines, ${(bytes / 1e6).toFixed(2)} MB in ${CLIPS_DIR}`);
