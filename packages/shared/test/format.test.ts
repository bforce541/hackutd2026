import { describe, expect, it } from 'vitest';
import {
  MINUS,
  dayToISODate,
  formatAxisMoney,
  formatDate,
  formatDayRelative,
  formatMoney,
  formatMonths,
  formatPercent,
  formatShortDate,
  formatSignedMoney,
  formatTimer,
  formatWholeDollars,
  isoDateToDay,
  isWeekend,
  weekdayOf,
} from '../src/format';

describe('formatMoney', () => {
  it('formats whole dollars without cents', () => {
    expect(formatMoney(195000)).toBe('$1,950');
    expect(formatMoney(6065000)).toBe('$60,650');
    expect(formatMoney(20795000)).toBe('$207,950');
    expect(formatMoney(0)).toBe('$0');
  });
  it('uses a true minus sign', () => {
    expect(formatMoney(-30000)).toBe(`${MINUS}$300`);
    expect(formatMoney(-30000)).toBe('−$300');
    expect(formatMoney(-30000).startsWith('-')).toBe(false);
  });
  it('shows cents only when they matter', () => {
    expect(formatMoney(1354)).toBe('$13.54');
    expect(formatMoney(5)).toBe('$0.05');
    expect(formatMoney(1354, { cents: 'never' })).toBe('$14');
    expect(formatMoney(195000, { cents: 'always' })).toBe('$1,950.00');
  });
  it('signs flows', () => {
    expect(formatSignedMoney(200000)).toBe('+$2,000');
    expect(formatSignedMoney(-120000)).toBe('−$1,200');
    expect(formatSignedMoney(0)).toBe('$0');
  });
  it('rounds to whole dollars', () => {
    expect(formatWholeDollars(55328)).toBe('$553');
    expect(formatWholeDollars(221400)).toBe('$2,214');
  });
  it('formats axis labels', () => {
    expect(formatAxisMoney(0)).toBe('$0');
    expect(formatAxisMoney(200000)).toBe('$2k');
    expect(formatAxisMoney(-100000)).toBe('−$1k');
    expect(formatAxisMoney(150000)).toBe('$1.5k');
  });
});

describe('ratios', () => {
  it('formats percentages', () => {
    expect(formatPercent(0.56)).toBe('56%');
    expect(formatPercent(0.69)).toBe('69%');
    expect(formatPercent(0.355, 1)).toBe('35.5%');
  });
  it('formats months to one decimal', () => {
    expect(formatMonths(1800 / 3065)).toBe('0.6 months');
    expect(formatMonths(4586 / 3065, 'short')).toBe('1.5 mo');
    expect(formatMonths(1)).toBe('1.0 month');
  });
});

describe('dates', () => {
  it('maps demo days to dates from Sat, Nov 7 2026', () => {
    expect(dayToISODate(0)).toBe('2026-11-07');
    expect(weekdayOf(0)).toBe('Sat');
    expect(formatDate(0)).toBe('Sat, Nov 7');
    expect(formatDate(3)).toBe('Tue, Nov 10');
    expect(formatDate(6)).toBe('Fri, Nov 13');
    expect(formatDate(11)).toBe('Wed, Nov 18');
    expect(formatDate(13)).toBe('Fri, Nov 20');
    expect(formatShortDate(13)).toBe('Nov 20');
    expect(formatDate(25)).toBe('Wed, Dec 2');
  });
  it('round-trips ISO dates', () => {
    expect(isoDateToDay('2026-11-10')).toBe(3);
    expect(isoDateToDay(dayToISODate(45))).toBe(45);
  });
  it('says today and tomorrow only for those days', () => {
    expect(formatDayRelative(0, 0)).toBe('today');
    expect(formatDayRelative(1, 0)).toBe('tomorrow');
    expect(formatDayRelative(3, 0)).toBe('Tue, Nov 10');
  });
  it('knows weekends', () => {
    expect(isWeekend(0)).toBe(true);
    expect(isWeekend(1)).toBe(true);
    expect(isWeekend(2)).toBe(false);
  });
  it('formats the call timer', () => {
    expect(formatTimer(64)).toBe('1:04');
    expect(formatTimer(0)).toBe('0:00');
  });
});
