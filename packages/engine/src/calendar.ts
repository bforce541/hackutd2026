import type { Day, Household, ISODate, ItemKind, Weekday } from './types';

const MS_PER_DAY = 86_400_000;
const WEEKDAYS: Weekday[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Bank transfers roll a weekend date forward to Monday. Card spending, fees and one-off charges don't. */
export const BANK_TRANSFER_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>([
  'paycheck', 'bill', 'loan_payment', 'card_autopay', 'transfer',
]);

function day0Ms(h: Pick<Household, 'day0Date'>): number {
  const [y, m, d] = h.day0Date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function utcDate(h: Pick<Household, 'day0Date'>, day: Day): Date {
  return new Date(day0Ms(h) + day * MS_PER_DAY);
}

export function dayToDate(h: Pick<Household, 'day0Date'>, day: Day): ISODate {
  return utcDate(h, day).toISOString().slice(0, 10);
}

export function dateToDay(h: Pick<Household, 'day0Date'>, date: ISODate): Day {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(y, m - 1, d) - day0Ms(h)) / MS_PER_DAY);
}

export function weekday(h: Pick<Household, 'day0Date'>, day: Day): Weekday {
  return WEEKDAYS[utcDate(h, day).getUTCDay()] as Weekday;
}

export function isWeekend(h: Pick<Household, 'day0Date'>, day: Day): boolean {
  const w = utcDate(h, day).getUTCDay();
  return w === 0 || w === 6;
}

/** Weekend → next business day. (No bank holidays: every v2.md date is a plain weekday.) */
export function postingDay(h: Pick<Household, 'day0Date'>, day: Day): Day {
  let d = day;
  while (isWeekend(h, d)) d += 1;
  return d;
}

/** 'Tue, Nov 10', the format v2.md and UI.md use for dates. */
export function shortDate(h: Pick<Household, 'day0Date'>, day: Day): string {
  const dt = utcDate(h, day);
  return `${WEEKDAYS[dt.getUTCDay()]}, ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

/**
 * The same day-of-month `months` later, as a demo day. The 31st in a 30-day month
 * lands on the last day of that month.
 */
export function addMonths(h: Pick<Household, 'day0Date'>, day: Day, months: number): Day {
  const dt = utcDate(h, day);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const target = Date.UTC(y, m, Math.min(dt.getUTCDate(), lastDay));
  return Math.round((target - day0Ms(h)) / MS_PER_DAY);
}
