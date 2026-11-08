import { shortDate } from './calendar';
import { applyChanges, cardAccounts, savingsAccount } from './changes';
import { forecast, SCORE_HORIZON_DAYS } from './forecast';
import { balancesOn } from './ledger';
import { formatMoney, formatMonths, formatPercent, formatPercent1 } from './money';
import type { Cents, Change, Color, Day, HealthScore, Household } from './types';

/** Sum of the household's monthly essentials ($3,065 for the demo household). */
export function monthlyEssentialsTotal(h: Household): Cents {
  return h.monthlyEssentials.reduce((s, e) => s + e.amount, 0);
}

/** Monthly debt payments, including the card minimum: every liability's `minPayment`. */
export function monthlyDebtPayments(h: Household): Cents {
  return h.accounts.filter((a) => a.isLiability).reduce((s, a) => s + (a.minPayment ?? 0), 0);
}

export function grossMonthlyIncome(h: Household): Cents {
  return h.grossAnnualIncome / 12;
}

/** Assets (including the home's value) minus everything owed. */
export function netWorth(h: Household): { assets: Cents; liabilities: Cents; netWorth: Cents } {
  let assets = 0;
  let liabilities = 0;
  for (const a of h.accounts) {
    if (a.isLiability) liabilities += a.balance;
    else assets += a.balance;
    if (a.assetValue) assets += a.assetValue;
  }
  return { assets, liabilities, netWorth: assets - liabilities };
}

/** The household with every balance replaced by its projected close on `day`. */
export function householdOn(h: Household, day: Day): Household {
  const bal = balancesOn(h, day);
  return { ...h, accounts: h.accounts.map((a) => ({ ...a, balance: bal.get(a.id) ?? a.balance })) };
}

function band(value: number, green: (v: number) => boolean, yellow: (v: number) => boolean): Color {
  if (green(value)) return 'green';
  if (yellow(value)) return 'yellow';
  return 'red';
}

/**
 * The four health scores, `SCORE_HORIZON_DAYS` ahead of `fromDay`, with `changes` applied.
 * Balances (savings, cards) are each account's projected close on `fromDay`.
 */
export function healthScores(h: Household, opts: { fromDay?: Day; changes?: Change[] } = {}): HealthScore[] {
  const fromDay = opts.fromDay ?? 0;
  const changes = opts.changes ?? [];
  const applied = applyChanges(h, changes);
  const now = householdOn(applied, fromDay);
  const floor = h.rules.checkingFloor;

  // Cash cushion: lowest intraday checking balance in the next 30 days.
  const fc = forecast(h, { fromDay, days: SCORE_HORIZON_DAYS, changes });
  const low = fc.lowest.amount;
  const lowWhen = shortDate(h, fc.lowest.day);
  const cushionColor: Color = low < 0 ? 'red' : low < floor ? 'yellow' : 'green';
  const cushion: HealthScore = {
    key: 'cash_cushion',
    value: low,
    display: formatMoney(low),
    color: cushionColor,
    reason:
      cushionColor === 'green'
        ? `Checking stays at or above your ${formatMoney(floor)} floor for the next 30 days (lowest ${formatMoney(low)} on ${lowWhen}).`
        : `Checking dips to ${formatMoney(low)} on ${lowWhen}, ${cushionColor === 'red' ? 'below $0' : `below your ${formatMoney(floor)} floor`}.`,
    improve:
      cushionColor === 'green'
        ? 'On track. PacePay texts you before anything pushes it under the floor.'
        : 'Move a payment past payday, or cover the gap without dipping into savings below its floor.',
  };

  // Emergency fund: savings ÷ monthly essentials.
  const essentials = monthlyEssentialsTotal(h);
  const savings = savingsAccount(now)?.balance ?? 0;
  const months = essentials > 0 ? savings / essentials : 0;
  const efColor = band(months, (v) => v >= 3, (v) => v >= 1);
  const emergency: HealthScore = {
    key: 'emergency_fund',
    value: months,
    display: formatMonths(months),
    color: efColor,
    reason: `${formatMoney(savings)} in savings covers ${formatMonths(months)} of essentials (${formatMoney(essentials)} a month).`,
    improve:
      efColor === 'green'
        ? 'On track: 3 months or more is the goal.'
        : `3 months is the goal: ${formatMoney(essentials * 3)} in savings.`,
  };

  // Credit use: card balances ÷ card limits.
  const cards = cardAccounts(now);
  const owed = cards.reduce((s, a) => s + Math.max(0, a.balance), 0);
  const limit = cards.reduce((s, a) => s + (a.limit ?? 0), 0);
  const use = limit > 0 ? owed / limit : 0;
  const cuColor = band(use, (v) => v < 0.3, (v) => v <= 0.5);
  const credit: HealthScore = {
    key: 'credit_use',
    value: use,
    display: formatPercent(use),
    color: cuColor,
    reason: `${formatMoney(owed)} of your ${formatMoney(limit)} card limit is in use.`,
    improve:
      cuColor === 'green'
        ? 'On track: under 30% is the goal.'
        : `Under 30% is the goal: a card balance of ${formatMoney(Math.floor(limit * 0.3))} or less.`,
  };

  // Debt-to-income: monthly debt payments ÷ gross monthly income.
  const debt = monthlyDebtPayments(h);
  const income = grossMonthlyIncome(h);
  const dti = income > 0 ? debt / income : 0;
  const dtiColor = band(dti, (v) => v < 0.36, (v) => v <= 0.43);
  const debtToIncome: HealthScore = {
    key: 'debt_to_income',
    value: dti,
    display: formatPercent1(dti),
    color: dtiColor,
    reason: `${formatMoney(debt)} a month in debt payments on ${formatMoney(Math.round(income))} a month of gross income.`,
    improve:
      dtiColor === 'green'
        ? 'On track: under 36% is the goal.'
        : 'Under 36% is the goal: paying off the card or the personal loan brings it down.',
  };

  return [cushion, emergency, credit, debtToIncome];
}
