import { addMonths } from './calendar';
import type { Account, Change, Day, Household, ScheduledItem } from './types';

/** Plain-data deep copy. Households are JSON, so this is exact and works in Node and the browser. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function findAccount(h: Household, id: string): Account | undefined {
  return h.accounts.find((a) => a.id === id);
}

export function checkingAccount(h: Household): Account {
  const a = h.accounts.find((x) => x.kind === 'checking');
  if (!a) throw new Error('household has no checking account');
  return a;
}

export function savingsAccount(h: Household): Account | undefined {
  return h.accounts.find((x) => x.kind === 'savings');
}

export function cardAccounts(h: Household): Account[] {
  return h.accounts.filter((x) => x.kind === 'credit_card');
}

/** The k-th scheduled date of a recurring item (k = 0 is `item.day`). */
function nthOccurrence(h: Household, item: ScheduledItem, k: number): Day {
  if (!item.every) return item.day;
  return 'days' in item.every ? item.day + k * item.every.days : addMonths(h, item.day, k * item.every.months);
}

/**
 * Moving a payment moves one occurrence, the way a lender moves one due date: the last one due on or
 * before the new date (or the first one, when moving earlier). So on day 0 "move the car payment to
 * Friday" moves Tuesday's payment, and after the clock jumps to day 11 the same request moves
 * December's.
 *
 * A recurring item is split so every other occurrence still posts on its date: earlier occurrences
 * become one-offs (`<id>#<day>`), the moved one becomes `<id>@<toDay>`, and the series restarts at
 * the following occurrence under the original id.
 */
function moveItem(h: Household, itemId: string, toDay: Day): void {
  const idx = h.scheduled.findIndex((s) => s.id === itemId);
  if (idx < 0) return;
  const item = h.scheduled[idx] as ScheduledItem;
  if (!item.every) {
    item.day = toDay;
    return;
  }
  let k = 0;
  while (nthOccurrence(h, item, k + 1) <= toDay) k += 1;

  const oneOff = (id: string, day: Day): ScheduledItem => {
    const copy: ScheduledItem = { ...item, id, day };
    delete copy.every;
    return copy;
  };
  const inserted: ScheduledItem[] = [];
  for (let j = 0; j < k; j += 1) {
    const d = nthOccurrence(h, item, j);
    inserted.push(oneOff(`${item.id}#${d}`, d));
  }
  inserted.push(oneOff(`${item.id}@${toDay}`, toDay));

  // Restart the series at the occurrence after the moved one.
  item.day = nthOccurrence(h, item, k + 1);
  h.scheduled.splice(idx, 0, ...inserted);
}

function moneyMove(
  h: Household,
  type: 'transfer' | 'pay_down',
  fromAccountId: string,
  toAccountId: string,
  amount: number,
  day: Day,
  n: number,
): ScheduledItem {
  const from = findAccount(h, fromAccountId);
  const to = findAccount(h, toAccountId);
  return {
    id: `${type}:${fromAccountId}>${toAccountId}:${day}#${n}`,
    accountId: fromAccountId,
    label: type === 'pay_down' ? `Pay down ${to?.name ?? toAccountId}` : `Transfer to ${to?.name ?? toAccountId}`,
    // Money leaves `from`: an asset goes down; a liability (borrowing) would go up.
    amount: from?.isLiability ? amount : -amount,
    counterAccountId: toAccountId,
    // Money arrives at `to`: an asset goes up; a liability goes down (less owed).
    counterAmount: to?.isLiability ? -amount : amount,
    day,
    // A move between the customer's own accounts at the same bank is instant, weekends included,
    // so it posts on its own day ('one_time') instead of rolling to Monday like an outside
    // bank transfer. Otherwise a Saturday savings move would land after Monday's mortgage.
    kind: 'one_time',
  };
}

/** Returns a new household with the changes applied. Never mutates `h`. */
export function applyChanges(h: Household, changes: Change[] = []): Household {
  const out = clone(h);
  changes.forEach((c, n) => {
    switch (c.type) {
      case 'add_item':
        out.scheduled.push(clone(c.item));
        break;
      case 'move_item':
        moveItem(out, c.itemId, c.toDay);
        break;
      case 'delay_item': {
        const item = out.scheduled.find((s) => s.id === c.itemId);
        if (item) moveItem(out, c.itemId, item.day + c.days);
        break;
      }
      case 'add_fee':
        out.scheduled.push({
          id: `fee:${c.day}#${n}`,
          accountId: checkingAccount(out).id,
          label: c.label,
          amount: -c.amount,
          day: c.day,
          kind: 'fee',
        });
        break;
      case 'charge_card':
        out.scheduled.push({
          id: `charge:${c.accountId}:${c.day}#${n}`,
          accountId: c.accountId,
          label: c.label,
          amount: c.amount, // more owed on the card
          day: c.day,
          kind: 'one_time',
        });
        break;
      case 'transfer':
      case 'pay_down':
        out.scheduled.push(moneyMove(out, c.type, c.fromAccountId, c.toAccountId, c.amount, c.day, n));
        break;
    }
  });
  return out;
}

/** Account ids a set of changes takes money from (for the off-limits check). */
export function accountsDrawnFrom(changes: Change[]): string[] {
  const ids: string[] = [];
  for (const c of changes) {
    if (c.type === 'transfer' || c.type === 'pay_down') ids.push(c.fromAccountId);
    if (c.type === 'charge_card') ids.push(c.accountId);
    if (c.type === 'add_item' && c.item.amount < 0) ids.push(c.item.accountId);
  }
  return ids;
}
