'use client';
/**
 * Arena tab: simulated lenders played by Nemotron, graded by Claude. The stat cards, the field of
 * run tiles (each opens that run's transcript in a side sheet), the legend and "Run 3 live"
 * (actions.runArenaLive), whose progress is three tiles that light up in the spectrum. Every count
 * and sentence derives from the results. Live mode shows state.arena (the server's /api/arena);
 * demo mode loads the real results shipped in public/demo/arena-results.json (regenerate it with
 * scripts/arena-to-demo.mjs). Says "Sample results" only when the data is a sample.
 * Owned by: dash-tabs-b.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { formatPercent, type ArenaResults } from '@pacepay/shared';
import type { DashboardProps } from '@/lib/view-model';
import { ArenaKey } from './arena/ArenaKey';
import { ArenaStats } from './arena/ArenaStats';
import { RunGrid } from './arena/RunGrid';
import { RunSheet } from './arena/RunSheet';

const DEMO_RESULTS = '/demo/arena-results.json';

const SPECTRUM = ['var(--coral)', 'var(--amber)', 'var(--leaf)'];

/** Demo mode: the real arena results from the static file; null until loaded (or if it is missing). */
function useDemoResults(enabled: boolean): ArenaResults | null {
  const [results, setResults] = useState<ArenaResults | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch(DEMO_RESULTS)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ArenaResults | null) => {
        if (!cancelled && data && Array.isArray(data.runs)) setResults(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return results;
}

export function ArenaTab({ state, actions }: DashboardProps) {
  const { arenaProgress } = state;
  // Live mode falls back to the shipped results when the server has none yet (a demo reset clears them).
  const serverHasRuns = !!state.arena && !state.arena.sample && state.arena.runs.length > 0;
  const demoResults = useDemoResults(state.mode === 'demo' || !serverHasRuns);
  const arena = state.mode === 'demo' || !serverHasRuns ? (demoResults ?? state.arena) : state.arena;
  const running = arenaProgress !== null && arenaProgress.done < arenaProgress.total;
  const clean = arena && arena.limitViolations === 0 && arena.disclosures === 0;

  const [openId, setOpenId] = useState<string | null>(null);
  const openIndex = arena && openId ? arena.runs.findIndex((r) => r.id === openId) : -1;
  const openRun = arena && openIndex >= 0 ? arena.runs[openIndex] : null;
  const close = useCallback(() => {
    setOpenId((id) => {
      // Hand focus back to the tile that opened the sheet.
      if (id) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(id)}"]`)?.focus());
      return null;
    });
  }, []);

  return (
    <section aria-labelledby="arena-h" className="mx-auto max-w-[78rem]">
      <div className="rise flex flex-wrap items-end justify-between gap-x-10 gap-y-4 px-1 pb-1 pt-2" style={{ '--d': '0ms' } as CSSProperties}>
        <div className="min-w-0">
          <p className="eyebrow text-muted">Negotiation arena{arena ? ` · ${arena.total} simulated lenders` : ''}</p>
          <h2 id="arena-h" className="display m-0 mt-2 max-w-[22ch] text-[2.75rem]">
            {clean
              ? `${arena.total} lenders. No limit broken, nothing disclosed.`
              : arena
                ? `${arena.total} lenders, each trying a different way to say no.`
                : 'Simulated lenders, each trying a different way to say no.'}
          </h2>
          <p className="mt-3 text-body text-muted">
            Played by Nemotron, graded by Claude.
            {arena ? ` PacePay read every offer back in ${formatPercent(arena.readBackRate)} of runs. Open any tile to read the call.` : ''}
          </p>
        </div>
        {arena?.sample ? <span className="eyebrow text-ochre">Sample results · the real run fills this in</span> : null}
      </div>

      <ArenaStats arena={arena} />
      <RunGrid runs={arena ? arena.runs : null} onOpen={setOpenId} />
      <ArenaKey />

      <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
        <button
          type="button"
          onClick={actions.runArenaLive}
          disabled={running}
          className="pp-write min-h-12 rounded-full bg-ink px-7 font-medium text-page transition-[opacity,transform] duration-[var(--dur-base)] ease-[var(--ease-out)] hover:opacity-90 active:scale-[0.97] disabled:opacity-50"
        >
          Run 3 live
        </button>
        {running && arenaProgress ? (
          <div role="status" className="flex items-center gap-3">
            <span className="flex gap-1" aria-hidden="true">
              {SPECTRUM.map((c, i) => (
                <span
                  key={c}
                  className="h-3 w-7 rounded-[5px] transition-colors duration-[var(--dur-slow)]"
                  style={{ background: i < arenaProgress.done ? c : 'var(--hairline)' }}
                />
              ))}
            </span>
            <span className="eyebrow text-muted">
              {arenaProgress.done} of {arenaProgress.total} done
            </span>
          </div>
        ) : arena === null ? (
          <p className="eyebrow m-0 text-muted">No runs yet</p>
        ) : null}
      </div>

      {openRun && arena ? <RunSheet run={openRun} position={openIndex + 1} total={arena.runs.length} onClose={close} /> : null}
    </section>
  );
}
