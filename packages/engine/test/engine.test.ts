import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyChanges, buildOptions, cdOptions, checkOffer, forecast, healthScores, monthlyCardSpend, netWorth,
  planCallTargets, simulate, type Household,
} from '../src/index';
import { $, fridayDeal, h, payRepair, REPAIR, WEEK } from './helpers';

// v2.md › "Demo household": $164 of card spending each Saturday from day 7, never from checking
describe('card.weeklySpend', () => {
  it('raises the card balance by $164 every Saturday from day 7', () => {
    const card = forecast(h, { days: 22, accountId: 'card' });
    const spendDays = card.days.filter((d) => d.items.some((i) => i.itemId === 'card_spend')).map((d) => [d.day, d.weekday]);
    expect(spendDays).toEqual([[7, 'Sat'], [14, 'Sat'], [21, 'Sat']]);
    expect(card.days[6]?.close).toBe($(2_800));
    expect(card.days[7]?.close).toBe($(2_964));
    expect(card.days[12]?.close).toBe($(2_214)); // the $750 autopay on day 12
    expect(card.days[13]?.close).toBe($(2_214)); // the CD alert's payoff amount
  });

  it('never touches checking', () => {
    const noSpend: Household = { ...h, scheduled: h.scheduled.filter((s) => s.kind !== 'card_spend') };
    expect(forecast(noSpend, { days: 60 }).days.map((d) => d.close)).toEqual(forecast(h, { days: 60 }).days.map((d) => d.close));
  });

  it('averages $710 a month', () => {
    expect(monthlyCardSpend(h)).toBe(71_067); // $164 × 52 ÷ 12 = $710.67, "about $710"
  });
});

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

describe('engine.pure', () => {
  afterEach(() => vi.restoreAllMocks());

  const runAll = (hh: Household) => ({
    forecast: forecast(hh, { changes: [payRepair] }),
    scores: healthScores(hh, { changes: [payRepair] }),
    netWorth: netWorth(hh),
    options: buildOptions(hh, REPAIR),
    cd: cdOptions(hh, 'cd'),
    offer: checkOffer(hh, { itemId: 'auto_payment', newDay: WEEK.fri, fee: $(20) }, { baseChanges: [payRepair] }),
    targets: planCallTargets(hh, 'auto_payment', { baseChanges: [payRepair] }),
    sim: simulate(hh, fridayDeal),
  });

  it('same inputs twice → deep-equal outputs', () => {
    expect(runAll(h)).toEqual(runAll(h));
  });

  it('never mutates its inputs (runs on a deep-frozen household)', () => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify(h)) as Household);
    expect(() => runAll(frozen)).not.toThrow();
    expect(frozen).toEqual(h);
    applyChanges(frozen, fridayDeal);
    expect(frozen.scheduled.find((s) => s.id === 'auto_payment')?.day).toBe(WEEK.tue);
  });

  it('reads no clock and no randomness', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Date.now() called'); });
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Math.random() called'); });
    expect(() => runAll(h)).not.toThrow();
  });
});

describe('simulate', () => {
  it('returns a 60-day forecast, four scores and net worth', () => {
    const s = simulate(h, fridayDeal);
    expect(s.forecast.days).toHaveLength(60);
    expect(s.scores.map((x) => x.key)).toEqual(['cash_cushion', 'emergency_fund', 'credit_use', 'debt_to_income']);
    expect(simulate(h, []).netWorth.netWorth).toBe($(60_650));
  });

  it('moves net worth by the money spent', () => {
    // Day 0 with the repair paid from checking: $650 less.
    expect(simulate(h, [payRepair]).netWorth.netWorth).toBe($(60_000));
  });
});
