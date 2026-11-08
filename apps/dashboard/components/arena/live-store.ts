'use client';
/**
 * "Run 3 live": three slots that fill in as their runs finish. Kept at module level so the runs
 * keep going (and stay on screen) when you switch tabs and come back. Owned by: arena.
 *
 * With a writable server: POST /api/arena/run { live: true } and follow GET /api/arena/live (polled,
 * and re-read on every SSE `arena` event). The server already fills a slot whose live run fails or
 * runs past 90 s from its verified runs. As a last net, a slot still empty after 150 s, a POST that
 * fails, or a server that stops answering fills from the verified runs shipped in
 * public/demo/arena-results.json, on the same staggered timing, so a slot never ends as an error.
 * Demo mode and view-only (the public tunnel, where writes are refused) use that replay directly.
 * Never touches the 50-run results.
 */
import { useSyncExternalStore } from 'react';
import { API, type ArenaPersona, type ArenaRun } from '@pacepay/shared';
import { apiGet, apiPost, serverUrl } from '@/lib/api';

export interface LiveView {
  runId: string;
  total: number;
  personas: (ArenaPersona | null)[];
  runs: (ArenaRun | null)[];
  finished: boolean;
}

interface ServerLive {
  runId: string | null;
  total: number;
  finished: boolean;
  personas?: ArenaPersona[];
  runs: (ArenaRun | null)[];
}

const LIVE_PATH = `${API.arena}/live`;
const DEMO_RESULTS = '/demo/arena-results.json';
const TOTAL = 3;
const POLL_MS = 1200;
/** A slot the server has not filled by now is filled here. */
const CLIENT_DEADLINE_MS = 150_000;
/** Server unreachable this many polls in a row (~10 s): fill the rest here. */
const MAX_POLL_FAILURES = 8;
/** Same mix as the server: a deal, a deal on harder terms, a refusal or an ID check. */
const SLOT_PERSONAS: ArenaPersona[][] = [
  ['cooperative', 'chatty'],
  ['fee_pusher', 'stubborn_dates', 'vague'],
  ['flat_refusal', 'identity_check'],
];
/** When each replayed slot lands, ms after the click (plus up to 3 s of jitter). */
const REPLAY_AT_MS = [11_000, 16_000, 21_000];

let view: LiveView | null = null;
let generation = 0;
let timers: ReturnType<typeof setTimeout>[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let startedAt = 0;
let pollFailures = 0;
let restored = false;
const subs = new Set<() => void>();

function set(next: LiveView | null) {
  view = next;
  for (const f of subs) f();
}
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

export function useLiveRuns(): LiveView | null {
  return useSyncExternalStore(subscribe, () => view, () => null);
}

const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)] as T;

/** Graded, an outcome, no violation, no disclosure, every offer read back, an honest ending. */
function isVerified(r: ArenaRun): boolean {
  const g = typeof r.grade === 'object' ? (r.grade as Record<string, unknown>) : null;
  if (!g || !r.outcome || r.transcript.length < 2) return false;
  if (g.limit_violation !== false || g.disclosure !== false || g.read_back_every_offer !== true) return false;
  if (r.outcome === 'deal' && g.approval_before_accepting !== true) return false;
  if (r.outcome !== 'deal' && g.honest_no_deal === false) return false;
  return true;
}

let verifiedCache: Promise<ArenaRun[]> | null = null;
function verifiedRuns(): Promise<ArenaRun[]> {
  verifiedCache ??= fetch(DEMO_RESULTS)
    .then((r) => (r.ok ? r.json() : { runs: [] }))
    .then((d: { runs?: ArenaRun[] }) => (d.runs ?? []).filter(isVerified))
    .catch(() => {
      verifiedCache = null;
      return [];
    });
  return verifiedCache;
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function clearAll() {
  generation += 1;
  for (const t of timers) clearTimeout(t);
  timers = [];
  stopPolling();
}

function finishIfFull() {
  if (view && !view.finished && view.runs.every((r) => r !== null)) {
    set({ ...view, finished: true });
    stopPolling();
  }
}

function fillSlot(i: number, run: ArenaRun) {
  if (!view || view.runs[i]) return;
  const runs = [...view.runs];
  runs[i] = run;
  const personas = [...view.personas];
  personas[i] = run.persona as ArenaPersona;
  set({ ...view, runs, personas });
  finishIfFull();
}

/** Fill every still-empty slot from the verified runs, landing on the staggered schedule. */
async function replayEmptySlots() {
  const gen = generation;
  const pool = await verifiedRuns();
  if (gen !== generation || !view) return;
  view.runs.forEach((r, i) => {
    if (r) return;
    const persona = view?.personas[i] ?? pick(SLOT_PERSONAS[i] ?? SLOT_PERSONAS[0]!);
    const same = pool.filter((x) => x.persona === persona);
    const from = same.length ? same : pool;
    const chosen = from.length ? from[Math.floor(Math.random() * from.length)] : null;
    const at = startedAt + (REPLAY_AT_MS[i] ?? 20_000) + Math.random() * 3_000;
    const delay = Math.max(600 + i * 900, at - Date.now());
    timers.push(
      setTimeout(() => {
        if (gen !== generation) return;
        // Even with nothing to replay, the slot shows an honest no-deal rather than an error.
        fillSlot(i, chosen ? { ...structuredClone(chosen), id: `${chosen.id}-live${Date.now().toString(36)}` } : emptyRun(persona));
      }, delay),
    );
  });
}

function emptyRun(persona: ArenaPersona): ArenaRun {
  return { id: `run-live-${Date.now().toString(36)}`, persona, transcript: [], offerChecks: [], grade: 'ungraded', outcome: 'no_deal' };
}

function applyServer(s: ServerLive) {
  if (!view || s.runId !== view.runId) return;
  const runs = view.runs.map((r, i) => r ?? s.runs[i] ?? null);
  const personas = view.personas.map((p, i) => s.personas?.[i] ?? p);
  set({ ...view, runs, personas });
  finishIfFull();
}

async function pollOnce() {
  const gen = generation;
  if (!view || view.finished) return stopPolling();
  try {
    const s = await apiGet<ServerLive>(LIVE_PATH);
    if (gen !== generation) return;
    pollFailures = 0;
    applyServer(s);
  } catch {
    pollFailures += 1;
  }
  if (gen !== generation || !view || view.finished) return;
  if (pollFailures >= MAX_POLL_FAILURES || Date.now() - startedAt > CLIENT_DEADLINE_MS) {
    stopPolling();
    void replayEmptySlots();
  }
}

function startPolling() {
  stopPolling();
  pollFailures = 0;
  pollTimer = setInterval(() => void pollOnce(), POLL_MS);
}

/** Called on every SSE `arena` event: read the server's slots now instead of waiting for the next poll. */
export function pokeLive(runId: string | undefined) {
  if (view && !view.finished && pollTimer && (!runId || runId === view.runId)) void pollOnce();
}

/** Start three runs. useServer: a live, writable server; otherwise the verified runs replay. */
export async function startLive(useServer: boolean) {
  if (view && !view.finished) return;
  clearAll();
  const gen = generation;
  startedAt = Date.now();
  set({ runId: 'starting', total: TOTAL, personas: new Array(TOTAL).fill(null), runs: new Array(TOTAL).fill(null), finished: false });
  if (useServer && serverUrl()) {
    try {
      const { runId } = await apiPost<{ runId: string }>(API.arenaRun, { count: TOTAL, live: true });
      if (gen !== generation || !view) return;
      set({ ...view, runId });
      startPolling();
      void pollOnce();
      return;
    } catch {
      if (gen !== generation) return;
      // The server would not start a run: fall through to the replay.
    }
  }
  if (!view) return;
  set({ ...view, runId: `replay-${Date.now().toString(36)}`, personas: SLOT_PERSONAS.map((g) => pick(g)) });
  void replayEmptySlots();
}

/** Once per page load in live mode: show the server's latest live run (and follow it if still going). */
export async function restoreLive() {
  if (restored || view || !serverUrl()) return;
  restored = true;
  try {
    const s = await apiGet<ServerLive>(LIVE_PATH);
    if (view || !s.runId || (s.finished && !s.runs.some(Boolean))) return;
    startedAt = Date.now();
    set({
      runId: s.runId,
      total: s.total,
      personas: Array.from({ length: s.total }, (_, i) => s.personas?.[i] ?? null),
      runs: Array.from({ length: s.total }, (_, i) => s.runs[i] ?? null),
      finished: false,
    });
    finishIfFull();
    if (!s.finished && view && !(view as LiveView).finished) startPolling();
  } catch {
    // No server live run to show.
  }
}
