import { dayToDate, weekday } from './calendar';
import { applyChanges, checkingAccount } from './changes';
import { project } from './ledger';
import type { Change, Day, Forecast, ForecastDay, Household } from './types';

/** Scores and offer checks look 30 days ahead; the chart shows 60. */
export const SCORE_HORIZON_DAYS = 30;
export const CHART_HORIZON_DAYS = 60;

export interface ForecastOptions {
  fromDay?: Day;
  days?: number;
  changes?: Change[];
  accountId?: string;
}

/**
 * One account's balance day by day (checking by default), for `days` days starting at `fromDay`.
 *
 * `lowest` is the lowest intraday balance in the window (earliest day on ties). Its causes are the
 * scheduled debits on or before that day since the most recent credit, so a dip points at the bills
 * that made it. One-off charges (like the repair being paid) are the trigger, not a cause, and are
 * left out: for the repair case the causes are the mortgage and the car payment.
 */
export function forecast(h: Household, opts: ForecastOptions = {}): Forecast {
  const fromDay = opts.fromDay ?? 0;
  const days = Math.max(1, Math.floor(opts.days ?? CHART_HORIZON_DAYS));
  const applied = applyChanges(h, opts.changes ?? []);
  const accountId = opts.accountId ?? checkingAccount(applied).id;
  const floor = applied.rules.checkingFloor;
  const lastDay = fromDay + days - 1;
  const ledger = project(applied, lastDay).get(accountId);
  if (!ledger) throw new Error(`unknown account ${accountId}`);

  const out: ForecastDay[] = [];
  for (let d = fromDay; d <= lastDay; d += 1) {
    const low = ledger.intradayLow[d] as number;
    out.push({
      day: d,
      date: dayToDate(applied, d),
      weekday: weekday(applied, d),
      open: ledger.open[d] as number,
      close: ledger.close[d] as number,
      intradayLow: low,
      items: (ledger.postings[d] ?? []).map((p) => ({ itemId: p.itemId, label: p.label, amount: p.amount })),
      belowFloor: low < floor,
      negative: low < 0,
    });
  }

  let lowestDay = out[0] as ForecastDay;
  for (const fd of out) if (fd.intradayLow < lowestDay.intradayLow) lowestDay = fd;

  // The most recent day before the low that had a credit; debits after it caused the dip.
  let start = fromDay;
  for (let d = lowestDay.day - 1; d >= fromDay; d -= 1) {
    if ((ledger.postings[d] ?? []).some((p) => p.amount > 0)) {
      start = d + 1;
      break;
    }
  }
  const causeItemIds: string[] = [];
  for (let d = start; d <= lowestDay.day; d += 1) {
    for (const p of ledger.postings[d] ?? []) {
      if (p.amount < 0 && p.kind !== 'one_time' && !causeItemIds.includes(p.itemId)) causeItemIds.push(p.itemId);
    }
  }

  return { accountId, days: out, lowest: { amount: lowestDay.intradayLow, day: lowestDay.day, causeItemIds } };
}
