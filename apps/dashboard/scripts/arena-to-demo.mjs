#!/usr/bin/env node
/**
 * Turns the arena's real results (data/arena.json, written after a full arena run) into the three
 * files that ship with the repo:
 *   - apps/dashboard/public/demo/arena-results.json: what demo mode (and a live server with no runs
 *     yet) shows. Same ArenaResults shape as GET /api/arena, with sample: false.
 *   - apps/server/src/arena/verified-runs.json: the clean, graded runs "Run 3 live" replays into a
 *     slot whose live run fails or runs long (agent/arena.ts).
 *   - docs/arena-transcripts.md: every transcript with the engine checks and the grader's notes.
 *
 * Usage (from anywhere): node apps/dashboard/scripts/arena-to-demo.mjs [path/to/arena.json]
 * The full rerun is one command from the repo root: pnpm arena:refresh
 */
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const src = resolve(process.argv[2] ?? resolve(repo, 'data/arena.json'));
const demoOut = resolve(here, '../public/demo/arena-results.json');
const verifiedOut = resolve(repo, 'apps/server/src/arena/verified-runs.json');
const docOut = resolve(repo, 'docs/arena-transcripts.md');

const arena = JSON.parse(readFileSync(src, 'utf8'));
if (!arena || !Array.isArray(arena.runs) || typeof arena.total !== 'number') {
  throw new Error(`${src} is not arena results (needs runId, total and runs)`);
}

// ---------------------------------------------------------------------------
// 1. Demo results
// ---------------------------------------------------------------------------

const results = {
  runId: arena.runId,
  total: arena.total,
  dealRate: arena.dealRate,
  limitViolations: arena.limitViolations,
  disclosures: arena.disclosures,
  readBackRate: arena.readBackRate,
  runs: arena.runs,
  sample: false,
};
mkdirSync(dirname(demoOut), { recursive: true });
writeFileSync(demoOut, `${JSON.stringify(results)}\n`);
console.log(`Wrote ${demoOut}: ${results.runs.length} runs from ${arena.runId}`);

// ---------------------------------------------------------------------------
// 2. Verified runs for live replays: graded, an outcome, no violation, no disclosure, every offer
//    read back, approval before accepting a deal, and an honest ending when there is no deal.
// ---------------------------------------------------------------------------

const graded = (r) => (r.grade && typeof r.grade === 'object' ? r.grade : null);
const verified = arena.runs.filter((r) => {
  const g = graded(r);
  if (!g || !r.outcome || !Array.isArray(r.transcript) || r.transcript.length < 2) return false;
  if (g.limit_violation !== false || g.disclosure !== false || g.read_back_every_offer !== true) return false;
  if (r.outcome === 'deal' && g.approval_before_accepting !== true) return false;
  if (r.outcome !== 'deal' && g.honest_no_deal === false) return false;
  return true;
});
mkdirSync(dirname(verifiedOut), { recursive: true });
writeFileSync(verifiedOut, `${JSON.stringify({ from: arena.runId, runs: verified })}\n`);
const byPersona = {};
for (const r of verified) byPersona[r.persona] = (byPersona[r.persona] ?? 0) + 1;
console.log(`Wrote ${verifiedOut}: ${verified.length} verified runs ${JSON.stringify(byPersona)}`);

// ---------------------------------------------------------------------------
// 3. Transcripts doc
// ---------------------------------------------------------------------------

const PERSONAS = [
  ['cooperative', 'Cooperative'],
  ['fee_pusher', 'Fee pusher'],
  ['stubborn_dates', 'Stubborn on dates'],
  ['vague', 'Vague'],
  ['flat_refusal', 'Flat refusal'],
  ['identity_check', 'Identity check'],
  ['chatty', 'Chatty'],
];
const pct = (x) => `${Math.round(x * 100)}%`;
const counted = arena.runs.filter((r) => r.grade !== 'errored');
const isDeal = (r) => (graded(r) ? graded(r).deal_reached === true : r.outcome === 'deal');
const outcomeWord = (r) =>
  r.grade === 'errored' ? 'errored' : r.outcome === 'handoff_verification' ? 'handed to Yoshua (ID check)' : isDeal(r) ? 'deal' : 'no deal';
const deals = counted.filter(isDeal).length;
const handoffs = counted.filter((r) => r.outcome === 'handoff_verification').length;
const noDeals = counted.length - deals - handoffs;
const missedReadBack = arena.runs.filter((r) => graded(r) && graded(r).read_back_every_offer === false);
const errored = arena.runs.filter((r) => r.grade === 'errored');
const when = statSync(src).mtime.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const out = [];
out.push('# Negotiation arena: transcripts', '');
out.push(
  `Run \`${arena.runId}\` on ${when}. Nemotron 3 Ultra played each lender; PacePay's negotiator answered over text; Claude Opus 5.5 graded every transcript.`,
  '',
);
out.push(
  `**Results:** ${arena.total} runs · ${deals} deals (${pct(arena.dealRate)}) · ${noDeals} honest no deals · ${handoffs} handed to Yoshua for an ID check · limit violations ${arena.limitViolations} · disclosures ${arena.disclosures} · offers read back ${pct(arena.readBackRate)}${errored.length ? ` · ${errored.length} errored (not counted)` : ''}`,
  '',
);
out.push('| Persona | Runs | Deals | No deal | Handoffs | Violations | Disclosures |', '|---|---|---|---|---|---|---|');
for (const [p, label] of PERSONAS) {
  const rs = counted.filter((r) => r.persona === p);
  if (!rs.length) continue;
  const d = rs.filter(isDeal).length;
  const h = rs.filter((r) => r.outcome === 'handoff_verification').length;
  const v = rs.filter((r) => graded(r)?.limit_violation === true).length;
  const x = rs.filter((r) => graded(r)?.disclosure === true).length;
  out.push(`| ${label} | ${rs.length} | ${d} | ${rs.length - d - h} | ${h} | ${v} | ${x} |`);
}
out.push('');
if (missedReadBack.length) out.push(`Runs where an offer wasn't read back: ${missedReadBack.map((r) => r.id).join(', ')}.`, '');
if (errored.length) out.push(`Errored runs (a model error or timeout; not counted): ${errored.map((r) => r.id).join(', ')}.`, '');

const speaker = (l, r) => (l.speaker === 'pacepay' ? 'PacePay' : l.speaker === 'counterparty' ? (r.lenderName ? `Lender (${r.lenderName})` : 'Lender') : 'Customer');
let n = 0;
for (const [p, label] of PERSONAS) {
  const rs = arena.runs.filter((r) => r.persona === p);
  if (!rs.length) continue;
  out.push('', `## ${label}`, '');
  for (const r of rs) {
    n += 1;
    const g = graded(r);
    const bits = [outcomeWord(r)];
    if (g?.deal_reached && g.final_terms?.day) bits.push(`${g.final_terms.day}, $${g.final_terms.fee ?? 0} fee`);
    if (g?.read_back_every_offer === false) bits.push('missed a read-back');
    if (g?.limit_violation) bits.push('LIMIT VIOLATION');
    if (g?.disclosure) bits.push('DISCLOSURE');
    out.push(`### ${n}. ${r.id} · ${bits.join(' · ')}`, '');
    for (const l of r.transcript) out.push(`- **${speaker(l, r)}:** ${String(l.text).replace(/\s+/g, ' ').trim()}`);
    if (r.offerChecks?.length) {
      out.push('', `*Engine checks:* ${r.offerChecks.map((c) => `${c.pass ? 'pass' : 'fail'} (${(c.reasons ?? []).join(', ')})`).join('; ')}`);
    }
    if (g?.notes) out.push('', `*Grader:* ${g.notes}`);
    else if (!g) out.push('', `*Grader:* ${r.grade === 'errored' ? 'errored, not counted' : 'not graded'}`);
    out.push('');
  }
}
writeFileSync(docOut, `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`);
console.log(`Wrote ${docOut}`);
console.log(
  `[arena] ${arena.runId}: ${arena.total} runs, ${deals} deals, ${noDeals} honest no deals, ${handoffs} handoffs, ${arena.limitViolations} limit violations, ${arena.disclosures} disclosures, read-back ${pct(arena.readBackRate)}, ${errored.length} errored`,
);
