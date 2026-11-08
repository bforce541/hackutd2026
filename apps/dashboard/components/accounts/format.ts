/** Display helpers for the Accounts tab. Owned by: dash-tabs-b. Formatting only, no money math. */
import { formatMoney, formatPercent, formatShortDate } from '@pacepay/shared';
import type { Account, Rules } from '@pacepay/shared';

/** 0.0690 -> "6.9%", 0.2499 -> "24.99%", 0.041 -> "4.1%". */
export function pct(ratio: number): string {
  return formatPercent(ratio, 2).replace(/\.?0+%$/, '%');
}

/** "21:00" -> "9 PM", "08:30" -> "8:30 AM". */
export function clock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h < 12 ? 'AM' : 'PM';
  const hour = h % 12 || 12;
  return m ? `${hour}:${String(m).padStart(2, '0')} ${suffix}` : `${hour} ${suffix}`;
}

/** The grey detail after an account's name: "4.1% · matures Nov 20", "$400/mo · 6.9%". */
export function accountDetail(a: Account, rules: Rules, day0Date: string): string {
  const parts: string[] = [];
  switch (a.kind) {
    case 'savings':
      if (rules.savingsFloor != null) parts.push(`Floor ${formatMoney(rules.savingsFloor)}`);
      break;
    case 'cd':
      if (a.apy != null) parts.push(pct(a.apy));
      if (a.maturesOn != null) parts.push(`matures ${formatShortDate(a.maturesOn, day0Date)}`);
      break;
    case 'ira':
      if (a.offLimits || rules.offLimitsAccountIds.includes(a.id)) parts.push('Off-limits');
      break;
    case 'auto_loan':
    case 'personal_loan':
      if (a.minPayment != null) parts.push(`${formatMoney(a.minPayment)}/mo`);
      if (a.apr != null) parts.push(pct(a.apr));
      break;
    case 'credit_card':
      if (a.limit != null) parts.push(`${formatMoney(a.limit)} limit`);
      if (a.apr != null) parts.push(pct(a.apr));
      break;
    case 'mortgage':
      if (a.minPayment != null) parts.push(`${formatMoney(a.minPayment)}/mo`);
      break;
    default:
      break;
  }
  return parts.join(' · ');
}
