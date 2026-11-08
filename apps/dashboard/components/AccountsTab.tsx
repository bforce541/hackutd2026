'use client';
/**
 * Accounts tab: net worth as the headline, then PNC's six categories as cards, with the next 14
 * days and your rules (and the Pause PacePay switch) beside them. Owned by: dash-tabs-b.
 */
import type { CSSProperties } from 'react';
import { formatMoney } from '@pacepay/shared';
import { useTween } from '@/lib/motion';
import type { DashboardProps } from '@/lib/view-model';
import { AccountList } from './accounts/AccountList';
import { NextDays } from './accounts/NextDays';
import { YourRules } from './accounts/YourRules';

export function AccountsTab({ state, actions }: DashboardProps) {
  const { assets, liabilities, netWorth } = state.household.netWorth;
  const shown = useTween(netWorth, { from: 0, ms: 1000 });
  return (
    <section aria-labelledby="acct-h" className="mx-auto max-w-[78rem]">
      <div className="rise flex flex-wrap items-end justify-between gap-x-10 gap-y-3 px-1 pb-6 pt-2" style={{ '--d': '0ms' } as CSSProperties}>
        <div>
          <p className="eyebrow text-muted">Accounts · {state.household.accountCount} in one place</p>
          <h2 id="acct-h" className="display num m-0 mt-2 text-hero">
            {formatMoney(Math.round(shown))}
          </h2>
          <p className="m-0 mt-2 text-body text-muted">Net worth</p>
        </div>
        <dl className="m-0 flex gap-8">
          <div>
            <dt className="eyebrow text-muted">Assets</dt>
            <dd className="display num m-0 mt-1 text-[1.5rem]">{formatMoney(assets)}</dd>
          </div>
          <div>
            <dt className="eyebrow text-muted">Owed</dt>
            <dd className="display num m-0 mt-1 text-[1.5rem]">{formatMoney(liabilities)}</dd>
          </div>
        </dl>
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,25rem)]">
        <AccountList state={state} />
        <div className="flex min-w-0 flex-col gap-5">
          <NextDays state={state} />
          <YourRules state={state} actions={actions} />
        </div>
      </div>
    </section>
  );
}
