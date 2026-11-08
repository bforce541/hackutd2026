import { describe, expect, it } from 'vitest';
import { checkOffer, planCallTargets, shortDate } from '../src/index';
import { $, h, payRepair, WEEK } from './helpers';

const ctx = { baseChanges: [payRepair] };
const offer = (newDay: number, fee = 0) => checkOffer(h, { itemId: 'auto_payment', newDay, fee }, ctx);

// v2.md › row "Car payment moved to Wednesday"
describe('offer.wednesdayFails', () => {
  it('fails: checking hits −$300 on Wednesday', () => {
    const c = offer(WEEK.wed);
    expect(c.pass).toBe(false);
    expect(c.affordable).toBe(false);
    expect(c.reasons).toEqual(expect.arrayContaining(['BELOW_FLOOR', 'NEGATIVE_BALANCE']));
    expect(c.lowest).toEqual({ amount: $(-300), day: WEEK.wed });
  });
});

// v2.md › row "Car payment moved to Friday, $20 fee"
describe('offer.fridayFee20Passes', () => {
  it('passes: the lowest point is exactly the $100 floor', () => {
    const c = offer(WEEK.fri, $(20));
    expect(c).toMatchObject({ pass: true, affordable: true, withinLimits: true, postsOnDay: WEEK.fri });
    expect(c.reasons).toEqual(['OK']);
    expect(c.lowest.amount).toBe($(100));
  });
});

// v2.md › "Thursday also fails"
describe('offer.thursdayPaydayRisky', () => {
  it('fails on payday: if the payment posts before the deposit, checking hits −$300', () => {
    const c = offer(WEEK.thu);
    expect(c.pass).toBe(false);
    expect(c.reasons).toContain('PAYDAY_SAME_DAY');
    expect(c.lowest).toEqual({ amount: $(-300), day: WEEK.thu });
  });
});

// v2.md › "A $35 fee is affordable but not allowed"
describe('offer.fee35AffordableNotAllowed', () => {
  it('is affordable ($1,665 on Friday) but over the $25 fee limit', () => {
    const c = offer(WEEK.fri, $(35));
    expect(c).toMatchObject({ pass: false, affordable: true, withinLimits: false });
    expect(c.reasons).toEqual(['FEE_OVER_LIMIT']);
  });

  it('a $25 fee is exactly at the limit and passes', () => {
    expect(offer(WEEK.fri, $(25)).pass).toBe(true);
  });
});

// SPEC.md › Behavior rules › Weekends
describe('offer.weekendRollsForward', () => {
  it('a Saturday offer posts Monday', () => {
    const sat = 7; // Sat, Nov 14
    expect(shortDate(h, sat)).toBe('Sat, Nov 14');
    const c = offer(sat);
    expect(c.postsOnDay).toBe(9);
    expect(shortDate(h, c.postsOnDay)).toBe('Mon, Nov 16');
    expect(c.reasons).toContain('WEEKEND_ROLLS_FORWARD');
    expect(c.pass).toBe(true);
  });
});

describe('offer.unknownItem', () => {
  it('rejects an item the household does not have', () => {
    const c = checkOffer(h, { itemId: 'nope', newDay: WEEK.fri, fee: 0 }, ctx);
    expect(c).toMatchObject({ pass: false, reasons: ['UNKNOWN_ITEM'] });
  });
});

describe('planCallTargets', () => {
  it('targets Friday, Nov 13, the first business day after payday that works', () => {
    const t = planCallTargets(h, 'auto_payment', ctx);
    expect(t.targetDay).toBe(WEEK.fri);
    expect(shortDate(h, t.targetDay)).toBe('Fri, Nov 13');
    expect(t.feeLimit).toBe($(25));
    expect(t.acceptableDays).not.toContain(WEEK.wed);
    expect(t.acceptableDays).not.toContain(WEEK.thu);
    expect(t.acceptableDays.every((d) => !['Sat', 'Sun'].includes(shortDate(h, d).slice(0, 3)))).toBe(true);
  });
});
