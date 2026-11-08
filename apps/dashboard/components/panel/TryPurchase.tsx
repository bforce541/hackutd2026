'use client';
/**
 * Try a purchase: type any amount, pick Checking or Card, and see what it does to the lowest
 * balance and the health scores. Never says "you can afford it": it shows the numbers and Yoshua
 * decides. Lives at the bottom of the What-if panel. Owned by: dash-panel.
 */
import { formatDate, formatMoney, SCORE_LABELS } from '@pacepay/shared';
import { cn } from '@/lib/cn';
import type { DashboardProps } from '@/lib/view-model';
import type { PayWith, Verdict } from '@/lib/purchase';
import { CONTROL_BORDER, Divider, Eyebrow, INPUT_FILL, Muted, Note } from './primitives';

const PAY_OPTIONS: { value: PayWith; label: string }[] = [
  { value: 'checking', label: 'Checking' },
  { value: 'card', label: 'Card' },
];

const VERDICT: Record<Verdict, { text: string; tone: string }> = {
  fine: { text: 'Stays above your minimum', tone: 'text-green' },
  tight: { text: 'Dips below your minimum', tone: 'text-ochre' },
  overdrawn: { text: 'Overdraws checking', tone: 'text-vermilion' },
};

const FIX_TEXT: Record<string, string> = {
  move_payment: 'Asking your lender to move the car payment keeps you above your minimum.',
  card: 'Putting it on your card keeps checking above your minimum.',
  savings: 'Using savings keeps checking above your minimum.',
};

export function TryPurchase({ state, actions }: DashboardProps) {
  const p = state.purchase;
  if (!p || !actions.setPurchaseText || !actions.setPurchasePayWith) return null;
  const { setPurchaseText, setPurchasePayWith } = actions;
  const r = p.result;
  const day0 = state.household.day0Date;
  const changedScores = r ? r.scores.filter((s) => s.changed) : [];

  return (
    <div className="mt-[1.25em]">
      <Divider />
      <Eyebrow className="mt-[1em] text-green">Try a purchase</Eyebrow>

      <div
        className={cn(
          'mt-[0.5em] flex items-center gap-[0.5em] rounded-lg border px-[0.75em] py-[0.5em] focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-green',
          CONTROL_BORDER,
          INPUT_FILL,
        )}
      >
        <span aria-hidden="true" className="text-muted">
          $
        </span>
        <label htmlFor="pp-purchase" className="sr-only">
          Purchase amount in dollars
        </label>
        <input
          id="pp-purchase"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="900"
          value={p.text}
          onChange={(e) => setPurchaseText(e.target.value)}
          aria-describedby={p.hint ? 'pp-purchase-hint' : undefined}
          aria-invalid={p.hint ? true : undefined}
          style={{ outline: 'none' }}
          className="block min-h-[1.45em] w-full min-w-0 border-0 bg-transparent p-0 text-[1em] text-ink outline-none focus-visible:outline-none placeholder:text-muted"
        />
        <div role="radiogroup" aria-label="Pay with" className="flex flex-none gap-[0.25em]">
          {PAY_OPTIONS.map((o) => {
            const on = p.payWith === o.value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setPurchasePayWith(o.value)}
                className={cn(
                  'min-h-8 cursor-pointer rounded-full border px-[0.75em] text-[0.875em] font-medium transition-colors duration-[var(--dur-base)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
                  on ? 'border-ink bg-ink text-page' : 'border-hairline bg-panel text-muted hover:text-ink',
                )}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      {p.hint && (
        <Note className="mt-[0.5em]">
          <span id="pp-purchase-hint">{p.hint}</span>
        </Note>
      )}

      {!r && !p.hint && <Note className="mt-[0.5em]">Type an amount to see the pace line change. It adds to the plan above.</Note>}

      {r && (
        <div className="mt-[0.75em]" aria-live="polite">
          <p className="m-0 text-subtitle leading-[1.25] font-semibold tracking-[-0.01em]">
            {formatMoney(r.lowestNow.amount)} → {formatMoney(r.lowestAfter.amount)}
          </p>
          <Muted className="mt-[0.125em]">
            Lowest in the next {state.ui.range} days, on {formatDate(r.lowestAfter.day, day0)}
          </Muted>
          <p className={cn('m-0 mt-[0.375em] font-medium', VERDICT[r.verdict].tone)}>{VERDICT[r.verdict].text}</p>
          {r.daysBelowZeroAfter > 0 && (
            <Muted className="mt-[0.125em]">
              Days below $0: {r.daysBelowZeroNow} → {r.daysBelowZeroAfter}
            </Muted>
          )}
          {changedScores.map((s) => (
            <Muted key={s.key} className="mt-[0.125em]">
              {SCORE_LABELS[s.key]}: {s.before.display} → {s.after.display}
            </Muted>
          ))}
          {r.fix && <Note className="mt-[0.5em]">{FIX_TEXT[r.fix.optionId]}</Note>}
        </div>
      )}
    </div>
  );
}
