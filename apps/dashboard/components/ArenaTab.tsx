'use client';
/**
 * Arena tab: "50 simulated lenders played by Nemotron, graded by Claude." The stat cards, the 10 x 5
 * field of run tiles, the legend and "Run 3 live" (actions.runArenaLive), whose progress is three
 * tiles that light up in the spectrum. Says "Sample results" only when the data is the sample.
 * Owned by: dash-tabs-b.
 */
import type { CSSProperties } from 'react';
import type { DashboardProps } from '@/lib/view-model';
import { ArenaKey } from './arena/ArenaKey';
import { ArenaStats } from './arena/ArenaStats';
import { RunGrid } from './arena/RunGrid';

const SPECTRUM = ['var(--coral)', 'var(--amber)', 'var(--leaf)'];

export function ArenaTab({ state, actions }: DashboardProps) {
  const { arena, arenaProgress } = state;
  const running = arenaProgress !== null && arenaProgress.done < arenaProgress.total;
  const clean = arena && arena.limitViolations === 0 && arena.disclosures === 0;

  return (
    <section aria-labelledby="arena-h" className="mx-auto max-w-[78rem]">
      <div className="rise flex flex-wrap items-end justify-between gap-x-10 gap-y-4 px-1 pb-1 pt-2" style={{ '--d': '0ms' } as CSSProperties}>
        <div className="min-w-0">
          <p className="eyebrow text-muted">Negotiation arena · {arena?.total ?? 50} simulated lenders</p>
          <h2 id="arena-h" className="display m-0 mt-2 max-w-[22ch] text-[2.75rem]">
            {clean
              ? `${arena.total} lenders. No limit broken, nothing disclosed.`
              : 'Fifty lenders, each trying a different way to say no.'}
          </h2>
          <p className="mt-3 text-body text-muted">Played by Nemotron, graded by Claude.</p>
        </div>
        {arena?.sample ? <span className="eyebrow text-ochre">Sample results · the real run fills this in</span> : null}
      </div>

      <ArenaStats arena={arena} />
      <RunGrid runs={arena ? arena.runs : null} />
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
    </section>
  );
}
