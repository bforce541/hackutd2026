/**
 * UI.md "One formatter": the single money and date formatter. The dashboard, the texts and the
 * chart PNGs all use these, so they always agree.
 *
 * - Money: "$1,950", no cents unless they matter, a true minus sign (U+2212), "+$2,000" when signed.
 * - Dates: "Tue, Nov 10". "today" and "tomorrow" only for those two days.
 * - Pure: no locale or timezone dependence except formatClockTime, which takes a time zone.
 */
import { DEMO_DAY0, WEEKDAYS } from './constants';
import type { Cents, Day, ISODate, Weekday } from './types';

export const MINUS = '−';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const WEEKDAYS_LONG: Record<Weekday, string> = {
  Sun: 'Sunday',
  Mon: 'Monday',
  Tue: 'Tuesday',
  Wed: 'Wednesday',
  Thu: 'Thursday',
  Fri: 'Friday',
  Sat: 'Saturday',
};

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export interface MoneyOptions {
  /** 'auto' (default): cents only when not a whole dollar. 'never': round to the dollar. 'always': two decimals. */
  cents?: 'auto' | 'always' | 'never';
  /** Prefix '+' on positive amounts (flows). Negative amounts always get the minus sign. */
  sign?: boolean;
}

function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 195000 -> "$1,950"; -30000 -> "−$300"; 1354 -> "$13.54"; with { cents: 'never' } 1354 -> "$14". */
export function formatMoney(cents: Cents, opts: MoneyOptions = {}): string {
  const mode = opts.cents ?? 'auto';
  const rounded = Math.round(cents);
  const abs = Math.abs(rounded);
  let body: string;
  if (mode === 'never' || (mode === 'auto' && abs % 100 === 0)) {
    const dollars = Math.round(abs / 100);
    body = groupThousands(dollars);
    if (dollars === 0) return '$0';
  } else {
    const dollars = Math.floor(abs / 100);
    const rest = String(abs % 100).padStart(2, '0');
    body = `${groupThousands(dollars)}.${rest}`;
  }
  if (rounded < 0) return `${MINUS}$${body}`;
  if (opts.sign && rounded > 0) return `+$${body}`;
  return `$${body}`;
}

/** A flow: "+$2,000", "−$1,200". */
export function formatSignedMoney(cents: Cents, opts: Omit<MoneyOptions, 'sign'> = {}): string {
  return formatMoney(cents, { ...opts, sign: true });
}

/** Whole dollars, for "about $14/mo": rounds to the nearest dollar. */
export function formatWholeDollars(cents: Cents): string {
  return formatMoney(cents, { cents: 'never' });
}

/** Chart axis labels: "$0", "$2k", "−$1k", "$1.5k". */
export function formatAxisMoney(cents: Cents): string {
  if (cents === 0) return '$0';
  const k = Math.abs(cents) / 100_000;
  const text = Number.isInteger(k) ? String(k) : String(Math.round(k * 10) / 10);
  return `${cents < 0 ? MINUS : ''}$${text}k`;
}

/** Dollars (as a model or a person said them) to integer cents. */
export function dollarsToCents(dollars: number): Cents {
  return Math.round(dollars * 100);
}

export function centsToDollars(cents: Cents): number {
  return cents / 100;
}

// ---------------------------------------------------------------------------
// Ratios
// ---------------------------------------------------------------------------

/** 0.56 -> "56%"; formatPercent(0.355, 1) -> "35.5%". Debt vs. income uses one decimal (SPEC §3). */
export function formatPercent(ratio: number, decimals = 0): string {
  const f = 10 ** decimals;
  const v = Math.round(ratio * 100 * f) / f;
  return `${v.toFixed(decimals)}%`;
}

/** 0.587 -> "0.6 months" (long) or "0.6 mo" (short). One decimal (SPEC §3). */
export function formatMonths(months: number, style: 'long' | 'short' = 'long'): string {
  const v = (Math.round(months * 10) / 10).toFixed(1);
  if (style === 'short') return `${v} mo`;
  return `${v} ${v === '1.0' ? 'month' : 'months'}`;
}

/** One decimal, no unit: 0.587 -> "0.6" (for "0.6 to 1.5 months"). */
export function formatOneDecimal(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

// ---------------------------------------------------------------------------
// Days and dates (all UTC math, so a Day never shifts with the viewer's time zone)
// ---------------------------------------------------------------------------

function isoToUtcMs(iso: ISODate): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function dayToUtcDate(day: Day, day0Date: ISODate): Date {
  return new Date(isoToUtcMs(day0Date) + day * 86_400_000);
}

/** Day 3 -> "2026-11-10". */
export function dayToISODate(day: Day, day0Date: ISODate = DEMO_DAY0): ISODate {
  return dayToUtcDate(day, day0Date).toISOString().slice(0, 10);
}

/** "2026-11-10" -> 3. */
export function isoDateToDay(iso: ISODate, day0Date: ISODate = DEMO_DAY0): Day {
  return Math.round((isoToUtcMs(iso) - isoToUtcMs(day0Date)) / 86_400_000);
}

/** Day 3 -> "Tue". */
export function weekdayOf(day: Day, day0Date: ISODate = DEMO_DAY0): Weekday {
  return WEEKDAYS[dayToUtcDate(day, day0Date).getUTCDay()] as Weekday;
}

/** Day 6 -> "Friday". */
export function formatWeekdayLong(day: Day, day0Date: ISODate = DEMO_DAY0): string {
  return WEEKDAYS_LONG[weekdayOf(day, day0Date)];
}

/** Day 3 -> "Nov 10". */
export function formatShortDate(day: Day, day0Date: ISODate = DEMO_DAY0): string {
  const d = dayToUtcDate(day, day0Date);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Day 3 -> "Tue, Nov 10". The house date format. */
export function formatDate(day: Day, day0Date: ISODate = DEMO_DAY0): string {
  return `${weekdayOf(day, day0Date)}, ${formatShortDate(day, day0Date)}`;
}

/** "today" / "tomorrow" relative to `today`, otherwise "Tue, Nov 10". */
export function formatDayRelative(day: Day, today: Day, day0Date: ISODate = DEMO_DAY0): string {
  if (day === today) return 'today';
  if (day === today + 1) return 'tomorrow';
  return formatDate(day, day0Date);
}

/** Saturday or Sunday. */
export function isWeekend(day: Day, day0Date: ISODate = DEMO_DAY0): boolean {
  const w = weekdayOf(day, day0Date);
  return w === 'Sat' || w === 'Sun';
}

/** Activity log times: "7:05 PM". Defaults to Dallas time, where the demo runs. */
export function formatClockTime(iso: string, timeZone = 'America/Chicago'): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
}

/** Call timer: 64 -> "1:04". */
export function formatTimer(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
