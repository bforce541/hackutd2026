import { describe, expect, it } from 'vitest';
import { cdOptions, formatMonths, formatPercent, healthScores, shortDate } from '../src/index';
import { $, h } from './helpers';

// v2.md › story step 7 and "The CD alert" bullet
describe('cd.options', () => {
  const opts = cdOptions(h, 'cd', { fromDay: 11 });
  const renew = opts.find((o) => o.id === 'cd_renew')!;
  const payoff = opts.find((o) => o.id === 'cd_payoff_card')!;

  it('the CD matures Fri, Nov 20 (day 13)', () => {
    expect(shortDate(h, 13)).toBe('Fri, Nov 20');
  });

  it('renewing earns about $205 a year', () => {
    expect(renew.tradeoffs.yearlyInterestEarned).toBe($(205));
  });

  it('pays off the card\'s day-13 balance: $2,800 + $164 − $750 = $2,214', () => {
    const payDown = payoff.changes.find((c) => c.type === 'pay_down');
    expect(payDown).toMatchObject({ fromAccountId: 'cd', toAccountId: 'card', amount: $(2_214), day: 13 });
  });

  it('saves about $550 a year (24.99% of $2,214 = $553.28)', () => {
    expect(payoff.tradeoffs.yearlyInterestSaved).toBe(55_328);
  });

  it('puts the other $2,786 in savings: $4,586, 0.6 → 1.5 months', () => {
    const toSavings = payoff.changes.find((c) => c.type === 'transfer');
    expect(toSavings).toMatchObject({ fromAccountId: 'cd', toAccountId: 'savings', amount: $(2_786) });
    expect(payoff.tradeoffs.savingsAfter).toBe($(4_586));
    expect(formatMonths(payoff.tradeoffs.emergencyMonthsBefore!)).toBe('0.6 months');
    expect(formatMonths(payoff.tradeoffs.emergencyMonthsAfter!)).toBe('1.5 months');
    expect(payoff.violations).toEqual([]);
  });

  it('credit use after is about 14% (one month of spending on a paid-off card)', () => {
    expect(formatPercent(payoff.tradeoffs.creditUseAfter!)).toBe('14%');
  });

  it('after the CD move, the emergency fund turns yellow and credit use green', () => {
    const s = Object.fromEntries(healthScores(h, { fromDay: 13, changes: payoff.changes }).map((x) => [x.key, x]));
    expect(s.emergency_fund).toMatchObject({ display: '1.5 months', color: 'yellow' });
    expect(s.credit_use?.color).toBe('green');
  });
});
