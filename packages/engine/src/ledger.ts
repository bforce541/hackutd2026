import { addMonths, BANK_TRANSFER_KINDS, postingDay } from './calendar';
import type { Cents, Day, Household, ItemKind, ScheduledItem } from './types';

export interface Posting {
  itemId: string;
  label: string;
  amount: Cents; // signed change to this account's balance
  kind: ItemKind;
  scheduledDay: Day; // before any weekend roll-forward
}

export interface AccountLedger {
  accountId: string;
  open: Cents[]; // index = day
  close: Cents[];
  intradayLow: Cents[]; // lowest point that day: deposits post before debits, so min(open, close)
  postings: Posting[][];
}

/** Every scheduled date of an item up to and including `maxDay`. */
export function occurrences(h: Household, item: ScheduledItem, maxDay: Day): Day[] {
  if (!item.every) return item.day <= maxDay ? [item.day] : [];
  const out: Day[] = [];
  if ('days' in item.every) {
    const step = item.every.days;
    if (step <= 0) return item.day <= maxDay ? [item.day] : [];
    for (let d = item.day; d <= maxDay; d += step) out.push(d);
  } else {
    const step = item.every.months;
    if (step <= 0) return item.day <= maxDay ? [item.day] : [];
    for (let k = 0; ; k += 1) {
      const d = addMonths(h, item.day, k * step);
      if (d > maxDay) break;
      out.push(d);
    }
  }
  return out;
}

/** The day an item's money actually moves: bank transfers roll off weekends. */
export function postsOn(h: Household, kind: ItemKind, day: Day): Day {
  return BANK_TRANSFER_KINDS.has(kind) ? postingDay(h, day) : day;
}

/** Every day an item posts, after weekend roll-forward, up to `maxDay`. */
export function postingDays(h: Household, item: ScheduledItem, maxDay: Day): Day[] {
  return occurrences(h, item, maxDay)
    .map((d) => postsOn(h, item.kind, d))
    .filter((d) => d <= maxDay);
}

/**
 * Projects every account from day 0 through `maxDay`. Day-0 balances are the accounts' `balance`.
 * Postings scheduled before day 0 are ignored.
 */
export function project(h: Household, maxDay: Day): Map<string, AccountLedger> {
  const len = maxDay + 1;
  const postings = new Map<string, Posting[][]>();
  for (const a of h.accounts) postings.set(a.id, Array.from({ length: len }, () => []));

  const add = (accountId: string, day: Day, p: Posting) => {
    if (day < 0 || day > maxDay) return;
    postings.get(accountId)?.[day]?.push(p);
  };

  for (const item of h.scheduled) {
    for (const scheduledDay of occurrences(h, item, maxDay)) {
      const day = postsOn(h, item.kind, scheduledDay);
      add(item.accountId, day, { itemId: item.id, label: item.label, amount: item.amount, kind: item.kind, scheduledDay });
      if (item.counterAccountId && item.counterAmount !== undefined) {
        add(item.counterAccountId, day, { itemId: item.id, label: item.label, amount: item.counterAmount, kind: item.kind, scheduledDay });
      }
    }
  }

  const ledgers = new Map<string, AccountLedger>();
  for (const a of h.accounts) {
    const ps = postings.get(a.id) as Posting[][];
    const open: Cents[] = [];
    const close: Cents[] = [];
    const intradayLow: Cents[] = [];
    let bal = a.balance;
    for (let d = 0; d < len; d += 1) {
      const today = ps[d] as Posting[];
      open.push(bal);
      // Banks post deposits before debits on the same day, so a paycheck landing the morning a bill
      // comes out covers it. The day's low is then just the lower of its open and its close.
      let all = 0;
      for (const p of today) all += p.amount;
      intradayLow.push(Math.min(bal, bal + all));
      bal += all;
      close.push(bal);
    }
    ledgers.set(a.id, { accountId: a.id, open, close, intradayLow, postings: ps });
  }
  return ledgers;
}

/** Closing balance of every account on `day`. */
export function balancesOn(h: Household, day: Day): Map<string, Cents> {
  const ledgers = project(h, Math.max(0, day));
  const out = new Map<string, Cents>();
  for (const [id, l] of ledgers) out.set(id, l.close[Math.max(0, day)] as Cents);
  return out;
}
