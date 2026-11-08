import type { Cents } from './types';

/** One month of interest on a balance at an APR, rounded to the cent. */
export function monthlyInterest(balance: Cents, apr: number): Cents {
  return Math.round((balance * apr) / 12);
}

/** One year of simple interest (APR or APY) on a balance, rounded to the cent. */
export function yearlyInterest(balance: Cents, rate: number): Cents {
  return Math.round(balance * rate);
}

/**
 * '$1,950', '$13.54', '−$300' (a real minus sign, as v2.md writes it).
 * Whole-dollar amounts drop the cents.
 */
export function formatMoney(cents: Cents): string {
  const sign = cents < 0 ? '−' : '';
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const rest = abs % 100;
  const whole = dollars.toLocaleString('en-US');
  return rest === 0 ? `${sign}$${whole}` : `${sign}$${whole}.${String(rest).padStart(2, '0')}`;
}

/** Ratio → '56%' (whole percent). */
export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** Ratio → '35.5%' (one decimal, used for debt-to-income). */
export function formatPercent1(ratio: number): string {
  return `${(Math.round(ratio * 1000) / 10).toFixed(1)}%`;
}

/** 0.587 → '0.6 months'. */
export function formatMonths(months: number): string {
  return `${(Math.round(months * 10) / 10).toFixed(1)} months`;
}
