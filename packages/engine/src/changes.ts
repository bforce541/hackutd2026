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

/** The day after an item's first occurrence, in its own rhythm. */
function nextOccurrence(h: Household, item: ScheduledItem): Day | null {
  if (!item.every) return null;
  return 'days' in item.every ? item.day + item.every.days : addMonths(h, item.day, item.every.months);
}

/**
 * Moving a payment moves only its next occurrence (`item.day`), the way a lender moves one due date.
 * A recurring item keeps its schedule from the following occurrence on; the moved one becomes a
 * one-off item with the id `<id>@<toDay>`.
 */
function moveItem(h: Household, itemId: string, toDay: Day): void {
  const idx = h.scheduled.findIndex((s) => s.id === itemId);
  if (idx < 0) return;
  const item = h.scheduled[idx] as ScheduledItem;
  const next = nextOccurrence(h, item);
  if (next === null) {
    item.day = toDay;
    return;
  }
  const moved: ScheduledItem = { ...item, id: `${item.id}@${toDay}`, day: toDay };
  delete moved.every;
  item.day = next;
  h.scheduled.splice(idx + 1, 0, moved);
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
    kind: 'transfer',
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
