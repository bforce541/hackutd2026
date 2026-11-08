'use client';
/**
 * Accounts tab (UI.md): left, accounts under PNC's six categories with net worth in the header;
 * right, "Next 14 days" (date · name · signed amount, moved payment on a green tint) and
 * "Your rules" with the Pause PacePay switch (actions.setRules, actions.togglePause).
 * Owned by: dash-tabs-b. Placeholder: account list.
 */
import { CATEGORIES, CATEGORY_LABELS, formatMoney } from '@pacepay/shared';
import type { DashboardProps } from '@/lib/view-model';

export function AccountsTab({ state }: DashboardProps) {
  return (
    <section aria-label="Accounts" className="flex flex-col gap-4">
      <p className="num text-label text-muted">Net worth {formatMoney(state.household.netWorth.netWorth)}</p>
      {CATEGORIES.map((c) => (
        <div key={c}>
          <h2 className="text-label font-semibold text-muted">{CATEGORY_LABELS[c]}</h2>
          {state.household.byCategory[c].map((a) => (
            <p key={a.id} className="flex justify-between">
              <span>{a.name}</span>
              <span className="num">{formatMoney(a.balance)}</span>
            </p>
          ))}
        </div>
      ))}
    </section>
  );
}
