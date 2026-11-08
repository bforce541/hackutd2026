import { billChange, fixtures, forecast, type Change } from '@pacepay/engine';
import { describe, expect, it } from 'vitest';
import { buildGeometry } from './pace-line';

const h = fixtures.household;
const repair = billChange(h, { amount: 65_000, day: 0, label: 'Northside Auto Service' });

const geometry = (changes: Change[], lowestDay?: number) => {
  const fc = forecast(h, { days: 60, changes });
  return {
    fc,
    g: buildGeometry({
      width: 1000,
      range: 14,
      line: fc,
      ghost: null,
      floor: h.rules.checkingFloor,
      lowestDay: lowestDay ?? fc.lowest.day,
      day0Date: h.day0Date,
      fontPx: 13,
    }),
  };
};

describe('pace line: the lowest-point dot', () => {
  // Car payment moved to Thursday (payday): the deposit posts first and covers it, so the day
  // never dips below its open or close.
  const { fc } = geometry([repair, { type: 'move_item', itemId: 'auto_payment', toDay: 5 }]);

  it('deposits post before debits, so a payday bill does not dip the day', () => {
    const thu = fc.days[5]!;
    expect(thu.intradayLow).toBe(Math.min(fc.days[4]!.close, thu.close));
    expect(thu.close).toBe(170_000);
  });

  it('with no intraday dip it matches the closing step (the $650 repair, Tuesday)', () => {
    const base = geometry([repair]);
    expect(base.fc.days[3]!.intradayLow).toBe(base.fc.days[3]!.close);
    expect(base.g.low!.negative).toBe(true);
    expect(base.g.low!.x).toBeCloseTo(((3 + 0.5) / 14) * 1000, 5);
  });

  it('when the named lowest day is outside the 14-day view, falls back to the lowest visible day', () => {
    const { g: view } = geometry([repair], 40);
    expect(view.low).not.toBeNull();
    expect(view.low!.x).toBeCloseTo(((3 + 0.5) / 14) * 1000, 5);
  });
});
