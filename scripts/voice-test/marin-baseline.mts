/**
 * marin's normal range: synthesizes ~20 real PacePay lines (each N times, same settings as
 * apps/voice/src/speech.ts) and prints duration per word, median pitch, level, clipping and noise per
 * clip, then the spread. The limits in apps/voice/src/audio-check.ts come from this. No calls, no texts.
 *
 *   npx @dotenvx/dotenvx run --convention=nextjs -q -- apps/server/node_modules/.bin/tsx \
 *     scripts/voice-test/marin-baseline.mts [takes=2] [outDir]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TTS_INSTRUCTIONS, TTS_MODEL, TTS_VOICE, ttsText } from '../../apps/voice/src/speech.ts';
import { clipProblems, clipStats, samplesOf } from '../../apps/voice/src/audio-check.ts';
import { FILLERS, INBOUND_FIXED_LINES, INBOUND_SECOND_FILLERS, likelyLines } from '../../apps/voice/src/conductor.ts';

const TAKES = Number(process.argv[2] ?? 2);
const OUT = process.argv[3];
if (OUT) mkdirSync(OUT, { recursive: true });
const LINES = [
  ...INBOUND_FIXED_LINES.slice(0, 6),
  ...FILLERS.map((f) => f.text).slice(0, 3),
  INBOUND_SECOND_FILLERS[0]!,
  ...likelyLines('Yoshua').slice(0, 4),
  'Okay, so just to confirm, that is Friday the 13th with no fee?',
  'Your checking balance is $1,240, and your paycheck of $1,850 lands Friday.',
  "Your next car payment is $412, due on the 10th. Moving it to Friday would cost nothing, the lender agreed.",
  "I'm just your financial assistant, so I can't help with that. Anything about your money?",
  'Yoshua approved. Could you confirm the new date and give me a reference number?',
  'Thanks, that is K, 7, Q, 2, M, 9.',
];

async function tts(text: string): Promise<Uint8Array> {
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, instructions: TTS_INSTRUCTIONS, response_format: 'pcm' }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

const rows: { text: string; take: number; st: ReturnType<typeof clipStats>; problems: string[]; ms: number }[] = [];
const jobs = LINES.flatMap((l) => Array.from({ length: TAKES }, (_, take) => ({ l, take })));
let next = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let j = jobs[next++]; j; j = jobs[next++]) {
      const text = ttsText(j.l);
      const pcm = await tts(text);
      const s = samplesOf(pcm);
      const t0 = performance.now();
      const st = clipStats(s, text);
      const ms = performance.now() - t0;
      rows.push({ text: j.l, take: j.take, st, problems: clipProblems(st), ms });
      if (OUT) writeFileSync(join(OUT, `${LINES.indexOf(j.l)}-${j.take}.pcm`), pcm);
    }
  }),
);
rows.sort((a, b) => LINES.indexOf(a.text) - LINES.indexOf(b.text) || a.take - b.take);
console.log('  sec  words s/word   f0  voiced  peak  clip%   rms noiseMs  calcMs | line');
for (const r of rows) {
  const s = r.st;
  console.log(
    `${s.soundSec.toFixed(2).padStart(5)} ${String(s.words).padStart(6)} ${s.secPerWord.toFixed(3).padStart(6)} ${String(s.f0).padStart(4)} ${String(s.voicedFrames).padStart(7)} ${String(s.peak).padStart(5)} ${s.clipPct.toFixed(3).padStart(6)} ${String(s.rms).padStart(5)} ${String(s.noiseMs).padStart(7)} ${r.ms.toFixed(1).padStart(7)} | ${r.text.slice(0, 60)}${r.problems.length ? `  <-- ${r.problems.join('; ')}` : ''}`,
  );
}
const col = (f: (s: ReturnType<typeof clipStats>) => number, voicedOnly = false) => {
  const v = rows.filter((r) => !voicedOnly || r.st.voicedFrames >= 8).map((r) => f(r.st)).sort((a, b) => a - b);
  return `min ${v[0]!.toFixed(3)} p10 ${v[Math.floor(v.length * 0.1)]!.toFixed(3)} median ${v[Math.floor(v.length / 2)]!.toFixed(3)} p90 ${v[Math.floor(v.length * 0.9)]!.toFixed(3)} max ${v[v.length - 1]!.toFixed(3)}`;
};
console.log(`\nclips ${rows.length}, flagged ${rows.filter((r) => r.problems.length).length}`);
console.log(`f0      ${col((s) => s.f0, true)}`);
console.log(`s/word  ${col((s) => s.secPerWord)}`);
console.log(`s/word (>=4 words) ${(() => { const v = rows.filter((r) => r.st.words >= 4).map((r) => r.st.secPerWord).sort((a, b) => a - b); return `min ${v[0]!.toFixed(3)} max ${v[v.length - 1]!.toFixed(3)}`; })()}`);
console.log(`peak    ${col((s) => s.peak)}`);
console.log(`clip%   ${col((s) => s.clipPct)}`);
console.log(`rms     ${col((s) => s.rms)}`);
console.log(`noiseMs ${col((s) => s.noiseMs)}`);
console.log(`calc ms max ${Math.max(...rows.map((r) => r.ms)).toFixed(1)}`);
