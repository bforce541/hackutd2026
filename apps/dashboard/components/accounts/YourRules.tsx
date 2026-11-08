'use client';
/**
 * "Your rules" (UI.md): keep-in-checking, keep-in-savings, most in fees, off-limits, quiet hours,
 * and the "Pause PacePay" switch (actions.togglePause). Owned by: dash-tabs-b.
 */
import { formatMoney } from '@pacepay/shared';
import { cn } from '@/lib/cn';
import type { DashboardProps } from '@/lib/view-model';
import { clock } from './format';

export function YourRules({ state, actions }: DashboardProps) {
  const { rules, household } = state;
  const paused = rules.paused === true;
  const offLimits = household.accounts.filter((a) => rules.offLimitsAccountIds.includes(a.id)).map((a) => a.name);

  const lines: { label: string; value: string }[] = [
    { label: 'Keep in checking', value: formatMoney(rules.checkingFloor) },
    { label: 'Keep in savings', value: formatMoney(rules.savingsFloor) },
    { label: 'Most in fees', value: formatMoney(rules.feeLimit) },
    { label: 'Off-limits', value: offLimits.length ? offLimits.join(', ') : 'None' },
    {
      label: 'Quiet hours',
      value: rules.quietHours ? `${clock(rules.quietHours.start)} to ${clock(rules.quietHours.end)}` : 'Off',
    },
  ];

  return (
    <section aria-labelledby="rules-h">
      <h2 id="rules-h" className="mb-2 text-xl font-semibold">
        Your rules
      </h2>
      <ul className="m-0 list-none p-0">
        {lines.map((l) => (
          <li key={l.label} className="flex items-baseline gap-3 border-t border-hairline py-2.5">
            <span className="min-w-0 flex-1 text-muted">{l.label}</span>
            <span className="num flex-none text-right font-medium">{l.value}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        role="switch"
        aria-checked={paused}
        onClick={actions.togglePause}
        className="flex min-h-12 w-full items-center gap-3 border-y border-hairline py-2.5 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block font-medium">Pause PacePay</span>
          <span className="block text-label text-muted">
            {paused ? "Paused. PacePay won't text or call." : 'PacePay texts first only when it matters.'}
          </span>
        </span>
        <span aria-hidden="true" className={cn('relative h-6 w-11 flex-none rounded-full transition-colors', paused ? 'bg-green' : 'bg-before-line')}>
          <span
            className={cn(
              'absolute top-[3px] size-[18px] rounded-full bg-panel shadow-[0_1px_2px_rgb(28_27_25/0.25)] transition-[left]',
              paused ? 'left-[23px]' : 'left-[3px]',
            )}
          />
        </span>
      </button>
    </section>
  );
}
