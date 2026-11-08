/**
 * "Try a purchase": what happens to checking and the health scores if Yoshua spends a typed amount
 * today, on checking or on the card. Pure: the engine does every number, this only frames them.
 * No data source is involved, so it works the same in demo and live mode.
 */
import { applyChanges, billChange, buildOptions, fixtures, simulate } from '@pacepay/engine';
import type { Cents, Change, Day, Forecast, HealthScore, Household, Lowest, OptionId, Rules, ScoreKey } from '@pacepay/shared';

export type PayWith = 'checking' | 'card';
export type Verdict = 'fine' | 'tight' | 'overdrawn';

export interface PurchaseInput {
  rules: Rules;
  /** Changes the plan already includes (a deal that moved the car payment, say). */
  accepted: Change[];
  day: Day;
  amount: Cents;
  payWith: PayWith;
  /** The chart's window: 14, 30 or 60 days. */
  range: number;
}

export interface ScoreDelta {
  key: ScoreKey;
  before: HealthScore;
  after: HealthScore;
  changed: boolean;
}

export interface PurchaseResult {
  verdict: Verdict;
  lowestNow: Lowest;
  lowestAfter: Lowest;
  daysBelowZeroNow: number;
  daysBelowZeroAfter: number;
  forecastNow: Forecast;
  forecastAfter: Forecast;
  scores: ScoreDelta[];
  /** When the purchase breaks a floor: the first option that keeps checking at or above it. */
  fix: { optionId: OptionId; lowest: Lowest } | null;
}

/** Most a typed amount can be ($50,000): keeps a stray extra zero from producing a nonsense chart. */
export const MAX_PURCHASE: Cents = 50_000_00;

function householdFor(rules: Rules): Household {
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
}

function lowestIn(f: Forecast, n: number): Lowest {
  let best: Lowest | null = null;
  for (const d of f.days.slice(0, n)) {
    if (best === null || d.intradayLow < best.amount) best = { amount: d.intradayLow, day: d.day };
  }
  return best ?? { amount: 0, day: 0 };
}

function daysBelowZero(f: Forecast, n: number): number {
  return f.days.slice(0, n).filter((d) => d.intradayLow < 0).length;
}

/** Parse "900", "$1,250.50" or "1250" into cents. Null for anything that isn't a positive amount. */
export function parseAmount(text: string): Cents | null {
  const cleaned = text.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return cents > 0 && cents <= MAX_PURCHASE ? cents : null;
}

export function tryPurchase(input: PurchaseInput): PurchaseResult {
  const { rules, accepted, day, amount, payWith, range } = input;
  const h = householdFor(rules);
  const label = 'Your purchase';
  const purchase: Change =
    payWith === 'card'
      ? { type: 'charge_card', accountId: 'card', amount, day, label }
      : billChange(h, { amount, day, label });

  const now = simulate(h, accepted, { fromDay: day });
  const after = simulate(h, [...accepted, purchase], { fromDay: day });
  const lowestNow = lowestIn(now.forecast, range);
  const lowestAfter = lowestIn(after.forecast, range);

  const verdict: Verdict = lowestAfter.amount < 0 ? 'overdrawn' : lowestAfter.amount < rules.checkingFloor ? 'tight' : 'fine';

  const scores: ScoreDelta[] = now.scores.map((before) => {
    const a = after.scores.find((s) => s.key === before.key) ?? before;
    return { key: before.key, before, after: a, changed: a.display !== before.display || a.color !== before.color };
  });

  let fix: PurchaseResult['fix'] = null;
  if (verdict !== 'fine') {
    const planned = applyChanges(h, accepted);
    const options = buildOptions(planned, { amount, day, label }, { fromDay: day });
    const order: OptionId[] = ['move_payment', 'card', 'savings'];
    for (const id of order) {
      const o = options.find((x) => x.id === id);
      if (o && o.violations.length === 0 && o.lowest.amount >= rules.checkingFloor && !(id === 'card' && payWith === 'card')) {
        fix = { optionId: id, lowest: o.lowest };
        break;
      }
    }
  }

  return {
    verdict,
    lowestNow,
    lowestAfter,
    daysBelowZeroNow: daysBelowZero(now.forecast, range),
    daysBelowZeroAfter: daysBelowZero(after.forecast, range),
    forecastNow: now.forecast,
    forecastAfter: after.forecast,
    scores,
    fix,
  };
}
