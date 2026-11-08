/**
 * What-if: result first (lowest now -> what if, days below $0), extra lines, checkbox rows, footer.
 * Every number arrives computed in state.whatIf (the engine runs in the browser). Owned by: dash-panel.
 */
import { formatMoney } from '@pacepay/shared';
import type { DashboardProps, WhatIfRow } from '@/lib/view-model';
import { cn } from '@/lib/cn';
import { CHECK_PATH, Divider, Eyebrow, Muted, Note, TextButton } from './primitives';
import { TryPurchase } from './TryPurchase';

function Checkbox({ row, onFlip }: { row: WhatIfRow; onFlip: () => void }) {
  const on = row.checked;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      onClick={onFlip}
      className="flex min-h-12 w-full cursor-pointer items-center gap-[0.75em] border-0 border-b border-hairline bg-transparent py-[0.625em] text-left text-[1em] text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-green"
    >
      <span
        aria-hidden="true"
        className={cn(
          'box-border flex size-[1.25em] flex-none items-center justify-center rounded-[4px] border-[1.5px]',
          on ? 'border-green bg-green' : 'border-before-line bg-panel',
        )}
      >
        {on && (
          <svg width="12" height="12" viewBox="0 0 20 20" className="block">
            <path d={CHECK_PATH} fill="none" stroke="#ffffff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="min-w-0 flex-auto">
        <span className="block font-medium">{row.label}</span>
        <span className="block text-[0.875em] text-muted">{row.detail}</span>
      </span>
    </button>
  );
}

export function WhatIf({ state, actions }: DashboardProps) {
  const wi = state.whatIf;
  const changed =
    !!wi && (wi.lowestNow.amount !== wi.lowestWhatIf.amount || wi.lowestNow.day !== wi.lowestWhatIf.day);
  const showDays = changed && !!wi && (wi.daysBelowZeroNow > 0 || wi.daysBelowZeroWhatIf > 0);
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-[1em]">
        <Eyebrow className="text-green">What if</Eyebrow>
        <TextButton className="px-[0.25em] font-medium" onClick={actions.toggleWhatIf}>
          Close
        </TextButton>
      </div>
      {wi && (
        <>
          <Note>Lowest in the next {state.ui.range} days</Note>
          <p className="m-0 mt-[0.125em] text-headline leading-[1.2] font-semibold tracking-[-0.01em]">
            {changed ? `${formatMoney(wi.lowestNow.amount)} → ${formatMoney(wi.lowestWhatIf.amount)}` : formatMoney(wi.lowestNow.amount)}
          </p>
          {showDays && (
            <Muted className="mt-[0.375em]">
              Days below $0: {wi.daysBelowZeroNow} → {wi.daysBelowZeroWhatIf}
            </Muted>
          )}
          {wi.extraLines.map((line) => (
            <Muted key={line} className="mt-[0.375em]">
              {line}
            </Muted>
          ))}
          <Divider className="mt-[1.25em]" />
          {wi.rows
            .filter((r) => r.available)
            .map((r) => (
              <Checkbox key={r.key} row={r} onFlip={() => actions.setWhatIf(r.key, !r.checked)} />
            ))}
        </>
      )}
      <TryPurchase state={state} actions={actions} />
      <Note className="mt-[0.75em]">Nothing changes until you say so.</Note>
    </div>
  );
}
