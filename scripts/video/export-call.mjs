#!/usr/bin/env node
// Export the real call's transcript for the video's call screen.
//
//   node scripts/video/export-call.mjs                 # latest outbound call in data/state.json
//   node scripts/video/export-call.mjs --call <id>     # a specific call from data/state.json
//   node scripts/video/export-call.mjs --server [--call <id>]   # from the running server instead
//
// Writes design/video/call-raw.json:
//   { callId, startedAt, endedAt, outcome, referenceNumber,
//     lines: [{ who: 'pacepay' | 'lender', text, at }] }   // at = seconds from the call's startedAt
// The server stamps each line when it ARRIVES (after the words were spoken, and startedAt is the dial,
// not when the recording started), so `at` is only a first guess at order and spacing.
// scripts/video/align-call.mjs does the real timing against the recorded audio.
// The phone number is never written out. Run it right after the take we use, before any reset.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const server = process.env.SERVER_URL || 'http://127.0.0.1:8787';
const wantId = opt('--call');

const listOf = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : []);

async function getJson(path) {
  const res = await fetch(`${server}${path}`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function loadCall() {
  if (flag('--server')) {
    let id = wantId;
    if (!id) {
      // the current case knows its call
      const cur = await getJson('/api/cases/current');
      const found = JSON.stringify(cur).match(/"(?:callId|activeCallId)"\s*:\s*"([^"]+)"/) || JSON.stringify(cur.call ?? {}).match(/"id"\s*:\s*"([^"]+)"/);
      id = found?.[1];
      if (!id) throw new Error('No call on the current case; pass --call <id> (the Activity tab shows it).');
    }
    return getJson(`/api/calls/${id}`);
  }
  const state = JSON.parse(readFileSync(join(root, 'data', 'state.json'), 'utf8'));
  const calls = listOf(state.calls);
  if (wantId) {
    const c = calls.find((x) => x.id === wantId);
    if (!c) throw new Error(`call ${wantId} not in data/state.json`);
    return c;
  }
  const outbound = calls
    .filter((c) => c.direction === 'outbound' && (c.transcript ?? []).length)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  if (!outbound.length) throw new Error('No outbound call with a transcript in data/state.json. Was the server reset after the take?');
  return outbound[outbound.length - 1];
}

const call = await loadCall();
const t0 = Date.parse(call.startedAt);
const lines = (call.transcript ?? [])
  .filter((l) => l.speaker === 'pacepay' || l.speaker === 'counterparty') // 'customer' lines belong to inbound calls
  .map((l) => ({
    who: l.speaker === 'pacepay' ? 'pacepay' : 'lender',
    text: String(l.text).trim(),
    at: +((Date.parse(l.at) - t0) / 1000).toFixed(2),
  }))
  .filter((l) => l.text);

const out = {
  callId: call.id,
  startedAt: call.startedAt,
  endedAt: call.endedAt ?? null,
  outcome: call.outcome ?? null,
  referenceNumber: call.referenceNumber ?? null,
  lines,
};
const dest = join(root, 'design', 'video', 'call-raw.json');
writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${dest}: ${lines.length} lines from call ${call.id} (${call.outcome ?? 'no outcome'})`);
