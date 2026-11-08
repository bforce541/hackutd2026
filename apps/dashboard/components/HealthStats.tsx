'use client';
/**
 * The four health stats under the chart (UI.md "Home"): Emergency fund, Card use, Debt vs.
 * income, Net worth, split by hairlines. Each is a button; clicking one shows its why and
 * how-to-improve line under the row, clicking again closes it. The goal sits next to the number,
 * "On track" once it is met (green, bold). No red, no grades.
 * Owned by: dash-tabs-b.
 */
import { formatMoney, SCORE_GOALS, SCORE_ON_TRACK } from '@pacepay/shared';
import { cn } from '@/lib/cn';
import type { ScoreKey } from '@pacepay/shared';
import type { DashboardProps, StatKey } from '@/lib/view-model';

const SCORE_ORDER: Exclude<ScoreKey, 'cash_cushion'>[] = ['emergency_fund', 'credit_use', 'debt_to_income'];

const SCORE_NAMES: Record<Exclude<ScoreKey, 'cash_cushion'>, string> = {
  emergency_fund: 'Emergency fund',
  credit_use: 'Card use',
  debt_to_income: 'Debt vs. income',
};

interface Stat {
  key: StatKey;
  label: string;
  value: string;
  note: string;
  onTrack: boolean;
  /** The why and how-to-improve line, shown when the stat is open. */
  detail: string;
}

export function HealthStats({ state, actions }: DashboardProps) {
  const { household } = state;
  const scoreStats: Stat[] = SCORE_ORDER.flatMap((key) => {
    const score = state.scores.find((s) => s.key === key);
    if (!score) return [];
    const onTrack = score.color === 'green';
    return [
      {
        key,
        label: SCORE_NAMES[key],
        value: score.display,
        note: onTrack ? SCORE_ON_TRACK[key] : SCORE_GOALS[key],
        onTrack,
        detail: `${score.reason} ${score.improve}`,
      },
    ];
  });

  const { assets, liabilities, netWorth } = household.netWorth;
  const stats: Stat[] = [
    ...scoreStats,
    {
      key: 'net_worth',
      label: 'Net worth',
      value: formatMoney(netWorth),
      note: `${household.accountCount} accounts`,
      onTrack: false,
      detail: `${formatMoney(assets)} in assets minus ${formatMoney(liabilities)} owed.`,
    },
  ];

  const open = stats.find((s) => s.key === state.ui.statOpen) ?? null;

  return (
    <section aria-label="Health stats" className="flex flex-col">
      <div className="grid grid-cols-2 border-t border-hairline sm:flex sm:flex-wrap">
        {stats.map((s, i) => {
          const isOpen = open?.key === s.key;
          return (
            <button
              key={s.key}
              type="button"
              aria-expanded={isOpen}
              onClick={() => actions.toggleStat(s.key)}
              className={cn(
                'flex min-w-0 flex-[1_1_150px] flex-col px-5 pt-4 pb-3 text-left',
                i === 0 && 'pl-0',
                i === 1 && 'border-l border-hairline',
                i === 2 && 'pl-0 sm:border-l sm:border-hairline sm:pl-5',
                i === 3 && 'border-l border-hairline',
                isOpen ? 'shadow-[inset_0_-2px_0_var(--green)]' : 'shadow-[inset_0_-2px_0_transparent]',
              )}
            >
              <span className="block text-label text-muted">{s.label}</span>
              <span className="num my-1 block text-stat leading-tight font-medium tracking-[-0.01em]">{s.value}</span>
              <span className={cn('block text-label', s.onTrack ? 'font-semibold text-green' : 'text-muted')}>{s.note}</span>
            </button>
          );
        })}
      </div>
      {open && (
        <p role="status" className="mt-3.5 text-body">
          <strong className="font-semibold">{open.label}:</strong>{' '}
          <span className="text-muted">{open.detail}</span>
        </p>
      )}
    </section>
  );
}
