'use client';
/**
 * The pace line (UI.md "The pace line"), built with visx: stepped line (curveStepAfter), $0 as
 * the heaviest gridline, dashed ochre minimum, hatching below $0 only, paycheck and bill markers
 * with labels that never cover a line (port the mockup's label placement), a dot on the lowest
 * point, the gray dashed ghost line, axis labels on the right, the range switch above.
 * Owned by: dash-paceline. Reads state.chart; never computes balances itself.
 * Placeholder: a plain SVG step line.
 */
import { CHART_RANGES, formatMoney } from '@pacepay/shared';
import { cn } from '@/lib/cn';
import type { DashboardProps } from '@/lib/view-model';

export function PaceLine({ state, actions }: DashboardProps) {
  const days = state.chart.line.days.slice(0, state.ui.range);
  const values = days.map((d) => d.close);
  const top = Math.max(...values, 0) + 30000;
  const bot = Math.min(...values, 0) - 30000;
  const W = 1000;
  const H = 300;
  const y = (v: number) => ((top - v) / (top - bot)) * H;
  const x = (i: number) => (i / Math.max(days.length, 1)) * W;
  const points = days.flatMap((d, i) => [`${x(i)},${y(d.close)}`, `${x(i + 1)},${y(d.close)}`]).join(' ');
  return (
    <section aria-label="Checking forecast" className="flex flex-col gap-2">
      <div className="flex items-center justify-end gap-4">
        {!state.call && (
          <button type="button" className="mr-auto min-h-11 text-label font-medium text-green" onClick={actions.toggleWhatIf}>
            What if
          </button>
        )}
        {CHART_RANGES.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={state.ui.range === r}
            onClick={() => actions.setRange(r)}
            className={cn('min-h-11 text-label', state.ui.range === r ? 'font-semibold text-ink underline decoration-green decoration-2 underline-offset-[0.45em]' : 'text-muted')}
          >
            {r} days
          </button>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[300px] w-full" role="img" aria-label={state.chart.status}>
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="var(--zero-line)" strokeWidth={1.5} />
        <line x1={0} x2={W} y1={y(state.chart.floor)} y2={y(state.chart.floor)} stroke="var(--ochre-line)" strokeDasharray="6 4" />
        <polyline points={points} fill="none" stroke="var(--green)" strokeWidth={2.5} />
      </svg>
      <p className="sr-only">Lowest {formatMoney(state.chart.lowest.amount)}</p>
    </section>
  );
}
