'use client';
/**
 * The PacePay panel (UI.md "Home, right"): the only white card, one step at a time. Renders
 * state.panel: Heads up, Limits, Call (with "Negotiating by text" and the lender console),
 * Approve, Done, What-if, CD alert. Owned by: dash-panel. Placeholder: the step name and headline.
 */
import { formatDate, formatMoney } from '@pacepay/shared';
import type { DashboardProps } from '@/lib/view-model';

export function PacePayPanel({ state, actions }: DashboardProps) {
  const p = state.panel;
  return (
    <aside aria-label="PacePay" className="rounded-xl bg-panel p-7 shadow-panel">
      {p.step === 'heads_up' ? (
        <div className="flex flex-col gap-3">
          <p className="text-headline font-medium num">
            {formatMoney(p.lowest.amount)} on {formatDate(p.lowest.day)}
          </p>
          <p className="text-muted">{p.condition}</p>
          <p className="font-medium">{p.best.title}</p>
          <p className="text-label text-muted">{p.best.detail}</p>
          <button type="button" className="min-h-11 rounded-lg bg-green px-4 font-medium text-white" onClick={() => actions.pickOption(p.best.optionId)}>
            {p.best.cta}
          </button>
        </div>
      ) : (
        <p className="text-muted">Step: {p.step}</p>
      )}
    </aside>
  );
}
