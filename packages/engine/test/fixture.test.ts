import { describe, expect, it } from 'vitest';
import { dayToDate, monthlyDebtPayments, monthlyEssentialsTotal, netWorth, shortDate, weekday } from '../src/index';
import { $, h } from './helpers';

// v2.md › "Demo household"
describe('fixture.summary', () => {
  it('day 0 is Saturday, Nov 7, 2026', () => {
    expect(dayToDate(h, 0)).toBe('2026-11-07');
    expect(weekday(h, 0)).toBe('Sat');
  });

  it('every account row matches v2.md', () => {
    const byId = Object.fromEntries(h.accounts.map((a) => [a.id, a]));
    expect(h.accounts).toHaveLength(8);
    expect(byId.checking?.balance).toBe($(1_950));
    expect(byId.savings?.balance).toBe($(1_800));
    expect(byId.cd).toMatchObject({ balance: $(5_000), apy: 0.041, maturesOn: 13 });
    expect(byId.ira).toMatchObject({ balance: $(14_200), offLimits: true });
    expect(byId.auto_loan).toMatchObject({ balance: $(13_400), minPayment: $(400), apr: 0.069 });
    expect(byId.personal_loan).toMatchObject({ balance: $(3_100), minPayment: $(150), apr: 0.119 });
    expect(byId.card).toMatchObject({ balance: $(2_800), limit: $(5_000), apr: 0.2499, minPayment: $(85) });
    expect(byId.mortgage).toMatchObject({ balance: $(128_000), minPayment: $(1_200), assetValue: $(185_000) });
    expect(h.rules).toMatchObject({ checkingFloor: $(100), savingsFloor: $(1_500), feeLimit: $(25), offLimitsAccountIds: ['ira'] });
  });

  it('every scheduled date in v2.md lands on the right weekday', () => {
    const due = Object.fromEntries(h.scheduled.map((s) => [s.id, s.day]));
    expect(shortDate(h, due.mortgage_payment!)).toBe('Mon, Nov 9');
    expect(shortDate(h, due.auto_payment!)).toBe('Tue, Nov 10');
    expect(shortDate(h, due.paycheck!)).toBe('Thu, Nov 12');
    expect(shortDate(h, due.card_autopay!)).toBe('Thu, Nov 19');
    expect(shortDate(h, 13)).toBe('Fri, Nov 20'); // CD matures
    for (const s of h.scheduled.filter((x) => x.kind !== 'card_spend')) {
      expect(['Sat', 'Sun']).not.toContain(weekday(h, s.day));
    }
  });

  it('essentials total $3,065 ($2,355 in bills and minimums + $710 of card spending)', () => {
    expect(monthlyEssentialsTotal(h)).toBe($(3_065));
    const card = h.monthlyEssentials.find((e) => e.label.startsWith('Card spending'));
    expect(monthlyEssentialsTotal(h) - (card?.amount ?? 0)).toBe($(2_355));
  });

  it('net worth is $60,650', () => {
    expect(netWorth(h)).toEqual({ assets: $(207_950), liabilities: $(147_300), netWorth: $(60_650) });
  });

  it('monthly debt payments are $1,835 (mortgage, car, personal loan, card minimum)', () => {
    expect(monthlyDebtPayments(h)).toBe($(1_835));
  });
});
