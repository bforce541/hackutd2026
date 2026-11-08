import { describe, expect, it } from 'vitest';
import { buildOptions, forecast, formatMonths, formatPercent, shortDate } from '../src/index';
import { $, h, REPAIR, WEEK } from './helpers';

const options = buildOptions(h, REPAIR);
const byId = Object.fromEntries(options.map((o) => [o.id, o]));

describe('options', () => {
  it('returns all three options for the repair', () => {
    expect(options.map((o) => o.id).sort()).toEqual(['card', 'move_payment', 'savings']);
  });
});

// v2.md › "The card option"
describe('options.card', () => {
  it('costs $13.54 a month in interest and takes card use from 56% to 69%', () => {
    const o = byId.card!;
    expect(o.tradeoffs.monthlyInterest).toBe(1354);
    expect(formatPercent(o.tradeoffs.creditUseBefore!)).toBe('56%');
    expect(formatPercent(o.tradeoffs.creditUseAfter!)).toBe('69%');
    expect(o.lowest.amount).toBe($(350)); // checking is untouched
    expect(o.violations).toEqual([]);
  });
});

// v2.md › "The savings option"
describe('options.savings', () => {
  it('moves $400, drops savings to $1,400 (below the $1,500 floor), 0.6 → 0.5 months', () => {
    const o = byId.savings!;
    const transfer = o.changes.find((c) => c.type === 'transfer');
    expect(transfer).toMatchObject({ fromAccountId: 'savings', toAccountId: 'checking', amount: $(400) });
    expect(o.tradeoffs.savingsAfter).toBe($(1_400));
    expect(o.violations).toEqual(['BELOW_SAVINGS_FLOOR']);
    expect(formatMonths(o.tradeoffs.emergencyMonthsBefore!)).toBe('0.6 months');
    expect(formatMonths(o.tradeoffs.emergencyMonthsAfter!)).toBe('0.5 months');
    expect(o.lowest.amount).toBe($(100)); // the transfer covers the dip exactly
  });
});

// Regression (integrator): a Saturday savings move used to roll to Monday and land after the
// mortgage, so a $700 bill left checking at $50, under the $100 floor.
describe('options.savings, any bill size', () => {
  it.each([650, 700, 900, 1_200])('a $%i bill: the savings move keeps checking at or above the floor', (dollars) => {
    const o = buildOptions(h, { amount: $(dollars), day: 0, label: 'Repair' }).find((x) => x.id === 'savings')!;
    expect(o.lowest.amount).toBeGreaterThanOrEqual($(100));
    expect(o.violations).not.toContain('BELOW_CHECKING_FLOOR');
  });

  it('the move posts the same day, even on a Saturday', () => {
    const o = buildOptions(h, REPAIR).find((x) => x.id === 'savings')!;
    const fc = forecast(h, { days: 3, changes: o.changes });
    expect(fc.days[WEEK.sat]?.close).toBe($(1_950 - 650 + 400));
  });
});

// v2.md › story step 2, the move-payment option ("move it to Fri, Nov 13")
describe('options.movePayment', () => {
  it('moves the car payment (not the mortgage) to the Friday after payday', () => {
    const o = byId.move_payment!;
    const move = o.changes.find((c) => c.type === 'move_item');
    expect(move).toEqual({ type: 'move_item', itemId: 'auto_payment', toDay: WEEK.fri });
    expect(shortDate(h, WEEK.fri)).toBe('Fri, Nov 13');
    expect(o.lowest.amount).toBe($(100));
    expect(o.violations).toEqual([]);
  });
});
