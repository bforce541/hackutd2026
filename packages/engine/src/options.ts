import { billItemId } from '@pacepay/shared';
import { applyChanges, cardAccounts, checkingAccount, findAccount, savingsAccount } from './changes';
import { forecast, SCORE_HORIZON_DAYS } from './forecast';
import { balancesOn, postingDays } from './ledger';
import { monthlyInterest, yearlyInterest } from './money';
import { planCallTargets } from './offers';
import { monthlyEssentialsTotal } from './scores';
import type { Cents, Change, Day, Household, Option, RuleViolation } from './types';

/** A bill to cover. `id` is the shared Bill's id when there is one (the item id becomes `bill:<id>`). */
export interface BillInput {
  amount: Cents;
  day: Day;
  label: string;
  id?: string;
}

const NO_TRADEOFFS: Option['tradeoffs'] = {
  monthlyInterest: null,
  creditUseBefore: null, creditUseAfter: null,
  savingsAfter: null,
  emergencyMonthsBefore: null, emergencyMonthsAfter: null,
  yearlyInterestSaved: null, yearlyInterestEarned: null,
};

/** The bill paid from checking on its day: the "do nothing" baseline every option starts from. */
export function billChange(h: Household, bill: BillInput): Change {
  return {
    type: 'add_item',
    item: {
      id: bill.id ? billItemId(bill.id) : 'bill',
      accountId: checkingAccount(h).id,
      label: bill.label,
      amount: -bill.amount,
      day: bill.day,
      kind: 'one_time',
    },
  };
}

function lowestOf(h: Household, changes: Change[], fromDay: Day) {
  const fc = forecast(h, { fromDay, days: SCORE_HORIZON_DAYS, changes });
  return { lowest: { amount: fc.lowest.amount, day: fc.lowest.day }, causes: fc.lowest.causeItemIds };
}

function checkingViolations(h: Household, lowest: Cents): RuleViolation[] {
  return lowest < h.rules.checkingFloor ? ['BELOW_CHECKING_FLOOR'] : [];
}

/** Average monthly card spending from the household's `card_spend` items (about $710 for the demo). */
export function monthlyCardSpend(h: Household): Cents {
  let perMonth = 0;
  for (const s of h.scheduled) {
    if (s.kind !== 'card_spend' || s.amount <= 0 || !s.every) continue;
    // Every n days: (amount × 52 weeks ÷ 12 months) × (7 ÷ n). v2.md's convention: $164 weekly → $710.
    perMonth += 'days' in s.every ? ((s.amount * 52) / 12) * (7 / s.every.days) : s.amount / s.every.months;
  }
  return Math.round(perMonth);
}

/**
 * The three ways to cover a bill, unranked (the orchestrator ranks them):
 * - `card`: charge it. Checking is untouched; trade-offs are a month of interest and credit use.
 * - `savings`: pay from checking and move the shortfall plus the floor in from savings.
 * - `move_payment`: pay from checking and move the soonest movable debit behind the dip to the
 *   first day that works (`planCallTargets`). Left out when no movable payment or no day works.
 */
export function buildOptions(h: Household, bill: BillInput, opts: { fromDay?: Day } = {}): Option[] {
  const fromDay = opts.fromDay ?? 0;
  const pay = billChange(h, bill);
  const withBill = lowestOf(h, [pay], fromDay);
  const now = balancesOn(h, fromDay);
  const options: Option[] = [];
  const essentials = monthlyEssentialsTotal(h);

  // 1. Card
  const card = cardAccounts(h)[0];
  if (card) {
    const changes: Change[] = [{ type: 'charge_card', accountId: card.id, amount: bill.amount, day: bill.day, label: bill.label }];
    const { lowest } = lowestOf(h, changes, fromDay);
    const owed = now.get(card.id) ?? card.balance;
    const limit = card.limit ?? 0;
    options.push({
      id: 'card',
      label: 'Put it on your card',
      changes,
      lowest,
      tradeoffs: {
        ...NO_TRADEOFFS,
        monthlyInterest: monthlyInterest(bill.amount, card.apr ?? 0),
        creditUseBefore: limit > 0 ? owed / limit : null,
        creditUseAfter: limit > 0 ? (owed + bill.amount) / limit : null,
      },
      violations: checkingViolations(h, lowest.amount),
    });
  }

  // 2. Savings
  const savings = savingsAccount(h);
  if (savings) {
    const shortfall = Math.max(0, h.rules.checkingFloor - withBill.lowest.amount);
    const changes: Change[] = [pay, { type: 'transfer', fromAccountId: savings.id, toAccountId: checkingAccount(h).id, amount: shortfall, day: bill.day }];
    const { lowest } = lowestOf(h, changes, fromDay);
    const before = now.get(savings.id) ?? savings.balance;
    const after = before - shortfall;
    const violations = checkingViolations(h, lowest.amount);
    if (after < h.rules.savingsFloor) violations.push('BELOW_SAVINGS_FLOOR');
    if (h.rules.offLimitsAccountIds.includes(savings.id)) violations.push('USES_OFF_LIMITS_ACCOUNT');
    options.push({
      id: 'savings',
      label: 'Move money from savings',
      changes,
      lowest,
      tradeoffs: {
        ...NO_TRADEOFFS,
        savingsAfter: after,
        emergencyMonthsBefore: essentials > 0 ? before / essentials : null,
        emergencyMonthsAfter: essentials > 0 ? after / essentials : null,
      },
      violations,
    });
  }

  // 3. Move a payment
  const applied = applyChanges(h, [pay]);
  const lastDay = fromDay + SCORE_HORIZON_DAYS - 1;
  const movable = withBill.causes
    .map((id) => applied.scheduled.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => !!s && s.movable === true)
    .sort((a, b) => (postingDays(applied, a, lastDay)[0] ?? 0) - (postingDays(applied, b, lastDay)[0] ?? 0));
  const target = movable[0];
  if (target) {
    const plan = planCallTargets(h, target.id, { baseChanges: [pay], fromDay });
    if (plan.targetDay >= 0) {
      const changes: Change[] = [pay, { type: 'move_item', itemId: target.id, toDay: plan.targetDay }];
      const { lowest } = lowestOf(h, changes, fromDay);
      options.push({
        id: 'move_payment',
        label: `Ask to move the ${target.label.toLowerCase()}`,
        changes,
        lowest,
        tradeoffs: { ...NO_TRADEOFFS },
        violations: checkingViolations(h, lowest.amount),
      });
    }
  }

  return options;
}

/**
 * What to do with a maturing CD, unranked:
 * - `cd_renew`: interest earned in a year at the CD's APY.
 * - `cd_payoff_card`: pay off the card's projected balance on the maturity day, put the rest in
 *   savings. `creditUseAfter` is a month of normal card spending on the paid-off card (v2.md:
 *   "about 14%, one month of spending").
 */
export function cdOptions(h: Household, cdAccountId: string, opts: { fromDay?: Day } = {}): Option[] {
  const fromDay = opts.fromDay ?? 0;
  const cd = findAccount(h, cdAccountId);
  if (!cd) return [];
  const m = cd.maturesOn ?? fromDay;
  const onMaturity = balancesOn(h, m);
  const cdBalance = onMaturity.get(cd.id) ?? cd.balance;
  const essentials = monthlyEssentialsTotal(h);
  const savings = savingsAccount(h);
  const savingsBefore = savings ? (onMaturity.get(savings.id) ?? savings.balance) : 0;
  const options: Option[] = [];

  const renewLowest = lowestOf(h, [], fromDay).lowest;
  options.push({
    id: 'cd_renew',
    label: 'Renew the CD',
    changes: [],
    lowest: renewLowest,
    tradeoffs: { ...NO_TRADEOFFS, yearlyInterestEarned: yearlyInterest(cdBalance, cd.apy ?? 0) },
    violations: [],
  });

  const card = cardAccounts(h)[0];
  if (card && savings) {
    const owed = Math.max(0, onMaturity.get(card.id) ?? card.balance);
    const payoff = Math.min(owed, cdBalance);
    const rest = cdBalance - payoff;
    const changes: Change[] = [{ type: 'pay_down', fromAccountId: cd.id, toAccountId: card.id, amount: payoff, day: m }];
    if (rest > 0) changes.push({ type: 'transfer', fromAccountId: cd.id, toAccountId: savings.id, amount: rest, day: m });
    const limit = card.limit ?? 0;
    const after = savingsBefore + rest;
    options.push({
      id: 'cd_payoff_card',
      label: 'Pay off your card and save the rest',
      changes,
      lowest: lowestOf(h, changes, fromDay).lowest,
      tradeoffs: {
        ...NO_TRADEOFFS,
        yearlyInterestSaved: yearlyInterest(payoff, card.apr ?? 0),
        creditUseBefore: limit > 0 ? owed / limit : null,
        creditUseAfter: limit > 0 ? (owed - payoff + monthlyCardSpend(h)) / limit : null,
        savingsAfter: after,
        emergencyMonthsBefore: essentials > 0 ? savingsBefore / essentials : null,
        emergencyMonthsAfter: essentials > 0 ? after / essentials : null,
      },
      violations: after < h.rules.savingsFloor ? ['BELOW_SAVINGS_FLOOR'] : [],
    });
  }

  return options;
}
