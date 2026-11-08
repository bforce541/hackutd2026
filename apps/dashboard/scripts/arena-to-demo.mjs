#!/usr/bin/env node
/**
 * Converts the arena's real results (data/arena.json, written by the server after an arena run)
 * into the static file demo mode loads: public/demo/arena-results.json. Same ArenaResults shape
 * as GET /api/arena, with sample: false.
 *
 * Usage (from anywhere): node apps/dashboard/scripts/arena-to-demo.mjs [path/to/arena.json]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(process.argv[2] ?? resolve(here, '../../../data/arena.json'));
const out = resolve(here, '../public/demo/arena-results.json');

const arena = JSON.parse(readFileSync(src, 'utf8'));
if (!arena || !Array.isArray(arena.runs) || typeof arena.total !== 'number') {
  throw new Error(`${src} is not arena results (needs runId, total and runs)`);
}

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

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(results)}\n`);
console.log(`Wrote ${out}: ${results.runs.length} runs from ${arena.runId}`);
