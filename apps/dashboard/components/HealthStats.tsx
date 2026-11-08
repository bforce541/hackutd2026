'use client';
/**
 * The four health stats under the chart (UI.md "Home"): Emergency fund, Card use, Debt vs.
 * income, Net worth, split by hairlines. Each is a button; clicking shows one why/improve line
 * under the row, clicking again closes it. Goal next to the number, "On track" once met; no red.
 * Owned by: dash-tabs-b. Placeholder: values only.
 */
import { formatMoney, SCORE_GOALS, SCORE_LABELS, SCORE_ON_TRACK } from '@pacepay/shared';
import type { DashboardProps, StatKey } from '@/lib/view-model';

export function HealthStats({ state, actions }: DashboardProps) {
  const stats: { key: StatKey; label: string; value: string; note: string }[] = [
    ...state.scores
      .filter((s) => s.key !== 'cash_cushion')
      .map((s) => ({
        key: s.key as StatKey,
        label: SCORE_LABELS[s.key],
        value: s.display,
        note: s.color === 'green' ? SCORE_ON_TRACK[s.key] : SCORE_GOALS[s.key],
      })),
    { key: 'net_worth', label: 'Net worth', value: formatMoney(state.household.netWorth.netWorth), note: `${state.household.accountCount} accounts` },
  ];
  return (
    <section aria-label="Health stats" className="flex border-t border-hairline">
      {stats.map((s) => (
        <button
          key={s.key}
          type="button"
          aria-expanded={state.ui.statOpen === s.key}
          onClick={() => actions.toggleStat(s.key)}
          className="flex-1 border-l border-hairline px-5 pt-4 pb-3 text-left first:border-l-0 first:pl-0"
        >
          <span className="block text-label text-muted">{s.label}</span>
          <span className="num block text-stat font-medium">{s.value}</span>
          <span className="block text-label text-muted">{s.note}</span>
        </button>
      ))}
    </section>
  );
}
