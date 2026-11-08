'use client';
/**
 * Arena tab (UI.md): "Negotiation arena", "50 simulated lenders played by Nemotron, graded by
 * Claude.", the stat row split by hairlines, the 10 x 5 grid of persona tiles with outcome marks,
 * the legend and "Run 3 live" (actions.runArenaLive). Says when the numbers are samples.
 * Owned by: dash-tabs-b. Placeholder: title and button.
 */
import type { DashboardProps } from '@/lib/view-model';

export function ArenaTab({ state, actions }: DashboardProps) {
  return (
    <section aria-label="Arena" className="flex flex-col gap-3">
      <h1 className="text-headline font-medium">Negotiation arena</h1>
      <p className="text-muted">50 simulated lenders played by Nemotron, graded by Claude.</p>
      <p className="num text-label text-muted">{state.arena ? `${state.arena.total} runs` : 'No runs yet'}</p>
      <button type="button" className="min-h-11 self-start rounded-lg bg-green px-4 font-medium text-white" onClick={actions.runArenaLive}>
        Run 3 live
      </button>
    </section>
  );
}
