'use client';
/**
 * Accounts under PNC's six categories, one line per account: name · detail · amount.
 * Liabilities show a true minus sign. The home's estimated value sits under Mortgage.
 * Owned by: dash-tabs-b.
 */
import { CATEGORIES, CATEGORY_LABELS, formatMoney } from '@pacepay/shared';
import type { Account } from '@pacepay/shared';
import type { DashboardState } from '@/lib/view-model';
import { accountDetail } from './format';

interface Props {
  state: DashboardState;
}

export function AccountList({ state }: Props) {
  const { household, rules } = state;
  return (
    <ul className="m-0 list-none border-b border-hairline p-0">
      {CATEGORIES.map((c) => {
        const accounts = household.byCategory[c] ?? [];
        if (accounts.length === 0) return null;
        return (
          <li key={c} className="block">
            <h3 className="flex pt-4.5 pb-1.5 text-chart font-semibold text-muted">{CATEGORY_LABELS[c]}</h3>
            <ul className="m-0 list-none p-0">
              {accounts.map((a) => (
                <AccountRow key={a.id} account={a} detail={accountDetail(a, rules, household.day0Date)} />
              ))}
              {c === 'mortgage' && household.byCategory.mortgage.map((a) =>
                a.assetValue != null ? (
                  <AccountRow key={`${a.id}-home`} name="Home value" detail="Estimate" amount={formatMoney(a.assetValue)} />
                ) : null,
              )}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

function AccountRow({
  account,
  detail,
  name,
  amount,
}: {
  account?: Account;
  detail?: string;
  name?: string;
  amount?: string;
}) {
  const label = name ?? account!.name;
  const value = amount ?? (account!.isLiability ? formatMoney(-account!.balance) : formatMoney(account!.balance));
  return (
    <li className="flex items-baseline gap-3 border-t border-hairline py-2">
      <span className="min-w-0 flex-1">{label}</span>
      {detail ? <span className="flex-none text-label text-muted">{detail}</span> : null}
      <span className="num flex-none min-w-[6.5em] text-right font-medium">{value}</span>
    </li>
  );
}
