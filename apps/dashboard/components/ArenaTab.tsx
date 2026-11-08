'use client';
/**
 * Arena tab (UI.md): "Negotiation arena", "50 simulated lenders played by Nemotron, graded by
 * Claude.", the stat row, the 10 x 5 grid of persona tiles with outcome marks, the legend and
 * "Run 3 live" (actions.runArenaLive). Says "Sample results" only when the data is the sample.
 * Owned by: dash-tabs-b.
 */
import type { DashboardProps } from '@/lib/view-model';
import { ArenaKey } from './arena/ArenaKey';
import { ArenaStats } from './arena/ArenaStats';
import { RunGrid } from './arena/RunGrid';

export function ArenaTab({ state, actions }: DashboardProps) {
  const { arena, arenaProgress } = state;
  const running = arenaProgress !== null && arenaProgress.done < arenaProgress.total;

  return (
    <section aria-labelledby="arena-h">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="arena-h" className="text-xl font-semibold">
          Negotiation arena
        </h2>
        {arena?.sample ? <span className="text-label font-semibold text-ochre">Sample results. The real run fills this in.</span> : null}
      </div>
      <p className="mt-1 text-muted">50 simulated lenders played by Nemotron, graded by Claude.</p>
      <ArenaStats arena={arena} />
      <RunGrid runs={arena ? arena.runs : null} />
      <ArenaKey />
      <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
        <button
          type="button"
          onClick={actions.runArenaLive}
          disabled={running}
          className="min-h-12 rounded-lg bg-green px-6 font-semibold text-white disabled:opacity-50"
        >
          Run 3 live
        </button>
        {running && arenaProgress ? (
          <p role="status" className="text-label text-muted">
            {arenaProgress.done} of {arenaProgress.total} done
          </p>
        ) : arena === null ? (
          <p className="text-label text-muted">No runs yet.</p>
        ) : null}
      </div>
    </section>
  );
}
