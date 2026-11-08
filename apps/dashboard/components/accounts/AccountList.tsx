'use client';
/**
 * Accounts under PNC's six categories, one card each: name with its detail underneath, amount on
 * the right. Liabilities show a true minus sign. The home's estimated value sits under Mortgage.
 * Owned by: dash-tabs-b.
 */
import type { CSSProperties } from 'react';
import { CATEGORIES, CATEGORY_LABELS, formatMoney } from '@pacepay/shared';
import type { Account } from '@pacepay/shared';
import type { DashboardState } from '@/lib/view-model';
import { accountDetail } from './format';

interface Props {
  state: DashboardState;
}

export function AccountList({ state }: Props) {
  const { household, rules } = state;
  let n = 0;
  return (
    <div className="grid min-w-0 items-start gap-5 md:grid-cols-2">
      {CATEGORIES.map((c) => {
        const accounts = household.byCategory[c] ?? [];
        if (accounts.length === 0) return null;
        const total = accounts.reduce((s, a) => s + (a.isLiability ? -a.balance : a.balance), 0);
        const delay = 80 + n++ * 70;
        return (
          <section
            key={c}
            aria-label={CATEGORY_LABELS[c]}
            className="rise rounded-[1.5rem] border border-hairline bg-panel p-5 shadow-panel"
            style={{ '--d': `${delay}ms` } as CSSProperties}
          >
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="eyebrow m-0 text-muted">{CATEGORY_LABELS[c]}</h3>
              <span className="eyebrow num text-muted">{formatMoney(total)}</span>
            </div>
            <ul className="m-0 mt-3 list-none p-0">
              {accounts.map((a) => (
                <AccountRow key={a.id} account={a} detail={accountDetail(a, rules, household.day0Date)} />
              ))}
              {c === 'mortgage' &&
                household.byCategory.mortgage.map((a) =>
                  a.assetValue != null ? <AccountRow key={`${a.id}-home`} name="Home value" detail="Estimate" amount={formatMoney(a.assetValue)} /> : null,
                )}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function AccountRow({ account, detail, name, amount }: { account?: Account; detail?: string; name?: string; amount?: string }) {
  const label = name ?? account!.name;
  const value = amount ?? (account!.isLiability ? formatMoney(-account!.balance) : formatMoney(account!.balance));
  return (
    <li className="flex items-baseline gap-3 border-t border-hairline py-3 first:border-t-0">
      <span className="min-w-0 flex-1">
        <span className="block font-medium leading-tight">{label}</span>
        {detail ? <span className="mt-0.5 block text-chart text-muted">{detail}</span> : null}
      </span>
      <span className="display num flex-none text-right text-[1.3rem]">{value}</span>
    </li>
  );
}
