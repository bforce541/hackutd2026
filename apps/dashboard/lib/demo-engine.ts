/**
 * Demo mode's door to the real money engine (@pacepay/engine), run in the browser.
 * Owned by: dash-demo.
 *
 * Every call is memoized by its inputs (the engine is pure, so the same input always gives the
 * same output) and nothing here runs at module scope (OWNERSHIP.md): the engine is only called
 * from the demo hook's initializer, its actions and its derive step.
 */
import {
  applyChanges,
  billChange,
  buildOptions,
  cdOptions,
  checkOffer,
  fixtures,
  forecast,
  grossMonthlyIncome,
  householdOn,
  monthlyDebtPayments,
  monthlyEssentialsTotal,
  netWorth,
  offerChanges,
  planCallTargets,
  simulate,
} from '@pacepay/engine';
import type { Cents, Change, Day, Forecast, HealthScore, Household, NetWorth, OfferCheck, Option, Rules } from '@pacepay/shared';

/** The repair from v2.md: what the bill photo says. */
export const REPAIR_MERCHANT = 'Northside Auto Service';
export const REPAIR_AMOUNT: Cents = 65_000;
/** The repair case is opened and worked on day 0; its numbers are always from that day. */
export const CASE_DAY: Day = 0;

export interface OfferTerms {
  newDay: Day;
  fee: Cents;
}

// ---------------------------------------------------------------------------
// Memo
// ---------------------------------------------------------------------------

const cache = new Map<string, unknown>();

function memo<T>(key: string, fn: () => T): T {
  if (cache.has(key)) return cache.get(key) as T;
  const value = fn();
  if (cache.size > 400) cache.clear();
  cache.set(key, value);
  return value;
}

const k = (...parts: unknown[]) => JSON.stringify(parts);

// ---------------------------------------------------------------------------
// The household, with Yoshua's rules from the Accounts tab
// ---------------------------------------------------------------------------

function rulesKey(rules: Rules) {
  return [rules.checkingFloor, rules.savingsFloor, rules.feeLimit, rules.offLimitsAccountIds];
}

/** The fixture household with the rules Yoshua set (floors, fee limit, off-limits accounts). */
export function household(rules: Rules): Household {
  return memo(k('household', rulesKey(rules)), () => {
    const base = fixtures.household as unknown as Household;
    return {
      ...base,
      rules: {
        ...base.rules,
        checkingFloor: rules.checkingFloor,
        savingsFloor: rules.savingsFloor,
        feeLimit: rules.feeLimit,
        offLimitsAccountIds: [...rules.offLimitsAccountIds],
      },
    };
  });
}

/** The rules the fixture ships with, plus the UI-only fields (quiet hours, pause). */
export function fixtureRules(): Rules {
  const r = (fixtures.household as unknown as Household).rules;
  return { ...r, offLimitsAccountIds: [...r.offLimitsAccountIds], quietHours: { start: '21:00', end: '08:00' }, paused: false };
}

// ---------------------------------------------------------------------------
// Memoized engine calls
// ---------------------------------------------------------------------------

/** The repair paid from checking on day 0 (the case's base change). */
export function repairChange(rules: Rules, amount: Cents): Change {
  return memo(k('bill', rulesKey(rules), amount), () =>
    billChange(household(rules), { amount, day: CASE_DAY, label: REPAIR_MERCHANT }) as Change,
  );
}

export function runForecast(rules: Rules, changes: Change[], fromDay: Day, days: number): Forecast {
  return memo(k('fc', rulesKey(rules), changes, fromDay, days), () =>
    forecast(household(rules), { changes, fromDay, days }) as Forecast,
  );
}

export function runSimulate(rules: Rules, changes: Change[], fromDay: Day): { forecast: Forecast; scores: HealthScore[]; netWorth: NetWorth } {
  return memo(k('sim', rulesKey(rules), changes, fromDay), () => simulate(household(rules), changes, { fromDay }) as never);
}

export function runOptions(rules: Rules, amount: Cents): Option[] {
  return memo(k('opts', rulesKey(rules), amount), () =>
    buildOptions(household(rules), { amount, day: CASE_DAY, label: REPAIR_MERCHANT }, { fromDay: CASE_DAY }) as Option[],
  );
}

export function runTargets(rules: Rules, base: Change[]) {
  return memo(k('targets', rulesKey(rules), base), () =>
    planCallTargets(household(rules), 'auto_payment', { baseChanges: base, fromDay: CASE_DAY }),
  );
}

export function runCheck(rules: Rules, base: Change[], offer: OfferTerms): OfferCheck {
  return memo(k('check', rulesKey(rules), base, offer), () =>
    checkOffer(
      household(rules),
      { id: `auto_payment:${offer.newDay}:${offer.fee}`, itemId: 'auto_payment', newDay: offer.newDay, fee: offer.fee },
      { baseChanges: base, fromDay: CASE_DAY },
    ) as OfferCheck,
  );
}

export function runOfferChanges(rules: Rules, offer: OfferTerms): Change[] {
  return memo(k('offerChanges', rulesKey(rules), offer), () =>
    offerChanges(household(rules), { itemId: 'auto_payment', newDay: offer.newDay, fee: offer.fee }) as Change[],
  );
}

/** cd_renew and cd_payoff_card, with `changes` (the current plan) already applied. */
export function runCdOptions(rules: Rules, changes: Change[], fromDay: Day): Option[] {
  return memo(k('cd', rulesKey(rules), changes, fromDay), () =>
    cdOptions(applyChanges(household(rules), changes), 'cd', { fromDay }) as Option[],
  );
}

/** Every account's balance at the start of `day` (the fixture's balances on day 0). */
export function householdAt(rules: Rules, changes: Change[], day: Day): Household {
  return memo(k('hhAt', rulesKey(rules), changes, day), () => {
    const h = household(rules);
    if (day <= 0) return h;
    return householdOn(applyChanges(h, changes), day - 1);
  });
}

export function netWorthAt(rules: Rules, changes: Change[], day: Day): NetWorth {
  return memo(k('nw', rulesKey(rules), changes, day), () => netWorth(householdAt(rules, changes, day)));
}

export function essentialsTotal(rules: Rules): Cents {
  return memo(k('essentials'), () => monthlyEssentialsTotal(household(rules)));
}

/** Debt payments and gross income a month, for the Debt vs. income line. */
export function debtAndIncome(rules: Rules): { debt: Cents; income: Cents } {
  return memo(k('dti'), () => {
    const h = household(rules);
    return { debt: monthlyDebtPayments(h), income: grossMonthlyIncome(h) };
  });
}

/** A scheduled item's amount as posted (the car payment: −$400). */
export function itemAmount(rules: Rules, itemId: string): Cents {
  return household(rules).scheduled.find((s) => s.id === itemId)?.amount ?? 0;
}

/** The CD's maturity day (Fri, Nov 20 = day 13). */
export function cdMaturesOn(rules: Rules): Day {
  return household(rules).accounts.find((a) => a.kind === 'cd')?.maturesOn ?? 13;
}
