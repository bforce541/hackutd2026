import { isWeekend, postingDay } from './calendar';
import { accountsDrawnFrom, applyChanges, savingsAccount } from './changes';
import { forecast, SCORE_HORIZON_DAYS } from './forecast';
import { postingDays } from './ledger';
import type { CallPlan, Change, Day, Household, OfferCheck, OfferReason } from './types';

export interface OfferInput {
  id?: string;
  itemId: string;
  newDay: Day;
  fee: number; // cents
}

export interface OfferContext {
  baseChanges: Change[]; // e.g. the repair paid from checking today
  fromDay?: Day;
}

/** The changes an accepted offer makes: move the payment, plus its fee on the same posting day. */
export function offerChanges(h: Household, offer: Omit<OfferInput, 'id'>, label = 'Fee to move the due date'): Change[] {
  const day = postingDay(h, offer.newDay);
  const changes: Change[] = [{ type: 'move_item', itemId: offer.itemId, toDay: day }];
  if (offer.fee > 0) changes.push({ type: 'add_fee', day, amount: offer.fee, label });
  return changes;
}

/**
 * Checks a lender's offer against the forecast and the customer's rules.
 * Affordability (the 30-day intraday low vs. the checking floor) and limits (fee, savings floor,
 * off-limits accounts) are reported separately, and a payment landing on a payday fails by rule.
 */
export function checkOffer(h: Household, offer: OfferInput, ctx: OfferContext): OfferCheck {
  const fromDay = ctx.fromDay ?? 0;
  const base = applyChanges(h, ctx.baseChanges);
  const offerId = offer.id ?? `${offer.itemId}:${offer.newDay}:${offer.fee}`;
  const postsOnDay = postingDay(h, offer.newDay);

  if (!base.scheduled.some((s) => s.id === offer.itemId)) {
    return { offerId, pass: false, affordable: false, withinLimits: false, postsOnDay, lowest: { amount: 0, day: fromDay }, reasons: ['UNKNOWN_ITEM'] };
  }

  const reasons: OfferReason[] = [];
  if (isWeekend(h, offer.newDay)) reasons.push('WEEKEND_ROLLS_FORWARD');

  const changes = [...ctx.baseChanges, ...offerChanges(h, offer)];
  const lastDay = fromDay + SCORE_HORIZON_DAYS - 1;
  const fc = forecast(h, { fromDay, days: SCORE_HORIZON_DAYS, changes });
  const floor = h.rules.checkingFloor;
  const affordable = fc.lowest.amount >= floor;
  if (fc.lowest.amount < floor) reasons.push('BELOW_FLOOR');
  if (fc.lowest.amount < 0) reasons.push('NEGATIVE_BALANCE');

  const applied = applyChanges(h, changes);
  const paydays = new Set(applied.scheduled.filter((s) => s.kind === 'paycheck').flatMap((s) => postingDays(applied, s, lastDay)));
  const payday = paydays.has(postsOnDay);
  if (payday) reasons.push('PAYDAY_SAME_DAY');

  const feeOk = offer.fee <= h.rules.feeLimit;
  if (!feeOk) reasons.push('FEE_OVER_LIMIT');
  const savings = savingsAccount(applied);
  const savingsOk = !savings || forecast(h, { fromDay, days: SCORE_HORIZON_DAYS, changes, accountId: savings.id }).lowest.amount >= h.rules.savingsFloor;
  const offLimits = new Set(h.rules.offLimitsAccountIds);
  const usesOffLimits = accountsDrawnFrom(changes).some((id) => offLimits.has(id));
  const withinLimits = feeOk && savingsOk && !usesOffLimits;

  const pass = affordable && withinLimits && !payday;
  if (pass) reasons.unshift('OK');
  return { offerId, pass, affordable, withinLimits, postsOnDay, lowest: { amount: fc.lowest.amount, day: fc.lowest.day }, reasons };
}

/** How far past the original due date the engine looks for a day that works. */
export const CALL_SEARCH_DAYS = 14;

/**
 * Every business day within two weeks after the payment's next due date (on or after `fromDay`)
 * that passes `checkOffer` with no fee, and the first of them as the target. `targetDay` is -1
 * when none works.
 */
export function planCallTargets(h: Household, itemId: string, ctx: OfferContext): Pick<CallPlan, 'targetDay' | 'acceptableDays' | 'feeLimit'> {
  const fromDay = ctx.fromDay ?? 0;
  const base = applyChanges(h, ctx.baseChanges);
  const item = base.scheduled.find((s) => s.id === itemId);
  const acceptableDays: Day[] = [];
  const due = item ? postingDays(base, item, fromDay + 400).find((d) => d >= fromDay) : undefined;
  if (due !== undefined) {
    for (let d = Math.max(due + 1, fromDay); d <= due + CALL_SEARCH_DAYS; d += 1) {
      if (isWeekend(h, d)) continue;
      if (checkOffer(h, { itemId, newDay: d, fee: 0 }, ctx).pass) acceptableDays.push(d);
    }
  }
  return { targetDay: acceptableDays[0] ?? -1, acceptableDays, feeLimit: h.rules.feeLimit };
}
