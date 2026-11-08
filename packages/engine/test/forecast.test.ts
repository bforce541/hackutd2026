import { describe, expect, it } from 'vitest';
import { forecast, type Change } from '../src/index';
import { $, fridayDeal, h, payRepair, WEEK } from './helpers';

const closes = (changes: Change[] = []) => forecast(h, { days: 7, changes }).days.map((d) => d.close);

// v2.md › "Checking this week", row "Before the quote"
describe('forecast.beforeQuote', () => {
  it('closes the week at $1,950 $1,950 $750 $350 $350 $2,350 $2,350, lowest $350', () => {
    const fc = forecast(h, { days: 7 });
    expect(fc.days.map((d) => d.close)).toEqual([1_950, 1_950, 750, 350, 350, 2_350, 2_350].map($));
    expect(fc.days.map((d) => d.weekday)).toEqual(['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    expect(fc.lowest.amount).toBe($(350));
  });

  it('stays at or above the $100 floor for 30 days without the repair', () => {
    expect(forecast(h, { days: 30 }).lowest.amount).toBeGreaterThanOrEqual($(100));
  });
});

// v2.md › "Checking this week", row "Pay $650 from checking, no fix"
describe('forecast.payFromChecking', () => {
  it('closes the week at $1,300 $1,300 $100 −$300 −$300 $1,700 $1,700', () => {
    expect(closes([payRepair])).toEqual([1_300, 1_300, 100, -300, -300, 1_700, 1_700].map($));
  });

  it('bottoms out at −$300 on Tuesday, caused by the mortgage and the car payment', () => {
    const fc = forecast(h, { days: 30, changes: [payRepair] });
    expect(fc.lowest.amount).toBe($(-300));
    expect(fc.lowest.day).toBe(WEEK.tue);
    expect(fc.lowest.causeItemIds).toEqual(['mortgage_payment', 'auto_payment']);
    const tue = fc.days[WEEK.tue]!;
    expect(tue.negative).toBe(true);
    expect(tue.belowFloor).toBe(true);
    expect(tue.items).toEqual([{ itemId: 'auto_payment', label: 'Car payment', amount: $(-400) }]);
  });
});

// v2.md › "Checking this week", row "Car payment moved to Friday, $20 fee"
describe('forecast.fridayDeal', () => {
  it('closes the week at $1,300 $1,300 $100 $100 $100 $2,100 $1,680, lowest $100', () => {
    expect(closes(fridayDeal)).toEqual([1_300, 1_300, 100, 100, 100, 2_100, 1_680].map($));
    expect(forecast(h, { days: 30, changes: fridayDeal }).lowest.amount).toBe($(100));
  });

  it('never drops below the floor over the 60-day chart', () => {
    expect(forecast(h, { days: 60, changes: fridayDeal }).days.every((d) => !d.belowFloor)).toBe(true);
  });

  it('keeps next month\'s car payment on its usual date (Thu, Dec 10 = day 33)', () => {
    const fc = forecast(h, { days: 60, changes: fridayDeal });
    const carDays = fc.days.filter((d) => d.items.some((i) => i.itemId.startsWith('auto_payment'))).map((d) => d.day);
    expect(carDays).toEqual([WEEK.fri, 33]);
  });
});
