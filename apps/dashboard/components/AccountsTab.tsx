'use client';
/**
 * Accounts tab (UI.md): left, accounts under PNC's six categories with net worth in the header;
 * right, "Next 14 days" (a moved payment on a green tint) and "Your rules" with the Pause PacePay
 * switch. Two columns straight on the page, wrapping to one at phone width.
 * Owned by: dash-tabs-b.
 */
import { formatMoney } from '@pacepay/shared';
import type { DashboardProps } from '@/lib/view-model';
import { AccountList } from './accounts/AccountList';
import { NextDays } from './accounts/NextDays';
import { YourRules } from './accounts/YourRules';

export function AccountsTab({ state, actions }: DashboardProps) {
  return (
    <section aria-label="Accounts" className="flex flex-wrap items-start gap-10">
      <section aria-labelledby="acct-h" className="min-w-0 flex-[1_1_360px]">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="acct-h" className="text-xl font-semibold">
            Accounts
          </h2>
          <span className="text-muted">
            Net worth <strong className="num font-semibold text-ink">{formatMoney(state.household.netWorth.netWorth)}</strong>
          </span>
        </div>
        <div className="mt-2">
          <AccountList state={state} />
        </div>
      </section>
      <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-8">
        <NextDays state={state} />
        <YourRules state={state} actions={actions} />
      </div>
    </section>
  );
}
