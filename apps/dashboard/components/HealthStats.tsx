'use client';
/**
 * The four health stats: Emergency fund, Card use, Debt vs. income, Net worth. Each score gets a
 * five-tile meter in the same spectrum as the chart (one tile = coral, five = leaf), so you read
 * "how close to the goal" without a gauge. Each stat is a button; click one to open its why and
 * how-to-improve line. The goal sits under the number, "On track" once it is met.
 * Owned by: dash-tabs-b.
 */
import type { CSSProperties } from 'react';
import { formatMoney, SCORE_GOALS, SCORE_ON_TRACK, type HealthScore, type ScoreKey } from '@pacepay/shared';
import { cn } from '@/lib/cn';
import type { DashboardProps, StatKey } from '@/lib/view-model';

const SCORE_ORDER: Exclude<ScoreKey, 'cash_cushion'>[] = ['emergency_fund', 'credit_use', 'debt_to_income'];

const SCORE_NAMES: Record<Exclude<ScoreKey, 'cash_cushion'>, string> = {
  emergency_fund: 'Emergency fund',
  credit_use: 'Card use',
  debt_to_income: 'Debt vs. income',
};

const LEVEL_COLORS = ['var(--coral)', 'var(--orange)', 'var(--amber)', 'var(--lime)', 'var(--leaf)'];

const clamp = (v: number) => Math.max(0, Math.min(1, v));

/** How many of the five tiles light up: 1 is far from the goal, 5 means it is met. */
export function meterLevel(key: Exclude<ScoreKey, 'cash_cushion'>, score: HealthScore): number {
  let frac: number;
  if (key === 'emergency_fund') frac = clamp(score.value / 3); // goal: 3 months of essentials
  else if (key === 'credit_use') frac = score.value <= 0.3 ? 1 : clamp(1 - (score.value - 0.3) / 0.4); // goal: under 30%
  else frac = score.value <= 0.36 ? 1 : clamp(1 - (score.value - 0.36) / 0.14); // goal: under 36%
  return Math.max(1, Math.min(5, Math.ceil(frac * 5 - 1e-9)));
}

interface Stat {
  key: StatKey;
  label: string;
  value: string;
  note: string;
  onTrack: boolean;
  level: number | null;
  /** The why and how-to-improve line, shown when the stat is open. */
  detail: string;
}

function Meter({ level, delay }: { level: number; delay: number }) {
  const color = LEVEL_COLORS[level - 1];
  return (
    <span className="flex gap-[3px]" role="img" aria-label={`${level} of 5`}>
      {[0, 1, 2, 3, 4].map((i) => {
        const lit = i < level;
        return (
          <span
            key={i}
            aria-hidden="true"
            className="h-3 w-[1.1rem] rounded-[4px]"
            style={
              {
                background: lit ? color : 'var(--hairline)',
                opacity: lit ? 0.55 + i * 0.11 : 1,
                animation: lit ? `pop 520ms var(--ease-out) ${delay + i * 80}ms both` : undefined,
              } as CSSProperties
            }
          />
        );
      })}
    </span>
  );
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
        level: meterLevel(key, score),
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
      level: null,
      detail: `${formatMoney(assets)} in assets minus ${formatMoney(liabilities)} owed.`,
    },
  ];

  const open = stats.find((s) => s.key === state.ui.statOpen) ?? null;

  return (
    <section aria-label="Health stats" className="flex flex-col">
      <h2 className="sr-only">Health stats</h2>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1 lg:grid-cols-4">
        {stats.map((s, i) => {
          const isOpen = open?.key === s.key;
          return (
            <button
              key={s.key}
              type="button"
              aria-expanded={isOpen}
              onClick={() => actions.toggleStat(s.key)}
              className={cn(
                'rise flex min-w-0 flex-col rounded-2xl border px-4 py-3.5 text-left transition-[background-color,border-color] duration-[var(--dur-base)] [html[data-presenter=true]_&]:py-2',
                isOpen ? 'border-hairline bg-panel' : 'border-transparent hover:bg-panel/70',
              )}
              style={{ '--d': `${160 + i * 50}ms` } as CSSProperties}
            >
              <span className="eyebrow block text-muted">{s.label}</span>
              <span className="display num mt-2 block whitespace-nowrap text-stat">{s.value}</span>
              <span className="mt-2.5 block h-3 [html[data-presenter=true]_&]:hidden">{s.level !== null && <Meter level={s.level} delay={420 + i * 120} />}</span>
              <span className={cn('mt-2.5 block text-chart [html[data-presenter=true]_&]:hidden', s.onTrack ? 'font-medium text-green' : 'text-muted')}>{s.note}</span>
            </button>
          );
        })}
      </div>
      <div
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-[var(--dur-slow)] ease-[var(--ease-out)]',
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="overflow-hidden">
          <p role="status" className="px-4 pb-1 pt-3 text-body">
            {open && (
              <>
                <strong className="font-semibold">{open.label}:</strong> <span className="text-muted">{open.detail}</span>
              </>
            )}
          </p>
        </div>
      </div>
    </section>
  );
}
