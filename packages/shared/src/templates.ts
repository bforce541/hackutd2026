/**
 * UI.md "iMessage": every exact text PacePay sends, as small typed functions.
 * Code fills the limits, calling, approval, done, reminder and bill-check texts from these
 * (SPEC §5.5). The ack, options text and CD alert are written by Super; the functions here are
 * their template fallbacks and the reference the facts check compares against.
 *
 * Amounts are cents. Values like "about $550" are passed already rounded by the caller (the
 * engine's facts object decides the rounding); these functions only format.
 */
import {
  formatDate,
  formatDayRelative,
  formatMoney,
  formatOneDecimal,
  formatWeekdayLong,
  formatWholeDollars,
  weekdayOf,
} from './format';
import type { Cents, Day, ISODate, Lowest } from './types';

interface DateCtx {
  day0Date?: ISODate;
}

const money = (c: Cents) => formatMoney(c);
const whole = (c: Cents) => formatWholeDollars(c);

// ---------------------------------------------------------------------------
// Bill photo
// ---------------------------------------------------------------------------

export interface BillTextParams extends DateCtx {
  merchant: string;
  amount: Cents;
  dueDay: Day | null;
  today: Day;
}

function duePhrase(p: BillTextParams): string {
  if (p.dueDay === null) return '';
  return `, due ${formatDayRelative(p.dueDay, p.today, p.day0Date)}`;
}

/** "Got it: $650 to Northside Auto Service, due today. Checking your week." */
export function ackText(p: BillTextParams): string {
  return `Got it: ${money(p.amount)} to ${p.merchant}${duePhrase(p)}. Checking your week.`;
}

/** "Is it $650 to Northside Auto Service, due today? YES or NO" (only when unsure). */
export function billCheckText(p: BillTextParams): string {
  return `Is it ${money(p.amount)} to ${p.merchant}${duePhrase(p)}? YES or NO`;
}

// ---------------------------------------------------------------------------
// The alert with options
// ---------------------------------------------------------------------------

/** "mortgage Mon": one cause or context item in the alert's parentheses. */
export function contextItem(label: string, day: Day, ctx: DateCtx = {}): string {
  return `${label} ${weekdayOf(day, ctx.day0Date)}`;
}

/** "I ask your lender to move the car payment to Fri" */
export function movePaymentOptionText(p: { itemLabel: string; toDay: Day } & DateCtx): string {
  return `I ask your lender to move the ${p.itemLabel} to ${weekdayOf(p.toDay, p.day0Date)}`;
}

/** "Put it on your card: about $14/mo interest" */
export function cardOptionText(p: { monthlyInterest: Cents }): string {
  return `Put it on your card: about ${whole(p.monthlyInterest)}/mo interest`;
}

/** "Use $400 of savings: drops below your $1,500 floor" */
export function savingsOptionText(p: { amount: Cents; savingsFloor: Cents; belowFloor: boolean }): string {
  const effect = p.belowFloor ? 'drops below' : 'stays above';
  return `Use ${whole(p.amount)} of savings: ${effect} your ${whole(p.savingsFloor)} floor`;
}

/** "Reply 1, 2 or 3." / "Reply 1 or 2." */
export function replyPrompt(count: number): string {
  if (count <= 1) return 'Reply 1.';
  const nums = Array.from({ length: count }, (_, i) => String(i + 1));
  return `Reply ${nums.slice(0, -1).join(', ')} or ${nums[nums.length - 1]}.`;
}

export interface AlertParams extends DateCtx {
  lowest: Lowest;
  /** "if you pay the repair today" */
  condition: string;
  /** ["mortgage Mon", "car payment Tue", "paycheck Thu"]; see contextItem. */
  context: string[];
  /** Option bodies in the order shown; option 1 is PacePay's pick. */
  options: string[];
  /** "no new debt": appended to option 1 as ". My pick: ..." */
  pickReason: string;
}

/**
 * Heads up: −$300 on Tue, Nov 10 if you pay the repair today (mortgage Mon, car payment Tue, paycheck Thu).
 * 1. I ask your lender to move the car payment to Fri. My pick: no new debt
 * 2. Put it on your card: about $14/mo interest
 * 3. Use $400 of savings: drops below your $1,500 floor
 * Reply 1, 2 or 3.
 */
export function alertText(p: AlertParams): string {
  const ctx = p.context.length ? ` (${p.context.join(', ')})` : '';
  const head = `Heads up: ${money(p.lowest.amount)} on ${formatDate(p.lowest.day, p.day0Date)} ${p.condition}${ctx}.`;
  const lines = p.options.map((o, i) => `${i + 1}. ${o}${i === 0 ? `. My pick: ${p.pickReason}` : ''}`);
  return [head, ...lines, replyPrompt(p.options.length)].join('\n');
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/** "I'll ask to move it to Fri, Nov 13, with $25 max in fees. OK?" */
export function limitsText(p: { toDay: Day; feeLimit: Cents } & DateCtx): string {
  return `I'll ask to move it to ${formatDate(p.toDay, p.day0Date)}, with ${whole(p.feeLimit)} max in fees. OK?`;
}

/** "Calling your lender now." */
export function callingText(): string {
  return 'Calling your lender now.';
}

function feePhrase(fee: Cents): string {
  return fee === 0 ? 'with no fee' : `for ${money(fee)}`;
}

/** "They'll move it to Fri, Nov 13 for $20. You stay above $100. Approve? YES or NO" */
export function dealApprovalText(p: { toDay: Day; fee: Cents; checkingFloor: Cents } & DateCtx): string {
  return `They'll move it to ${formatDate(p.toDay, p.day0Date)} ${feePhrase(p.fee)}. You stay above ${whole(p.checkingFloor)}. Approve? YES or NO`;
}

/**
 * The deal approval when the agreed day is a weekend day that posts on the next business day, so
 * the day said on the call and the day in the forecast both show:
 * "They'll move it to Sat, Nov 14 with no fee. It posts Mon, Nov 16. You stay above $100. Approve? YES or NO"
 */
export function dealApprovalPostsText(p: { toDay: Day; postsOnDay: Day; fee: Cents; checkingFloor: Cents } & DateCtx): string {
  if (p.postsOnDay === p.toDay) return dealApprovalText(p);
  return `They'll move it to ${formatDate(p.toDay, p.day0Date)} ${feePhrase(p.fee)}. It posts ${formatDate(p.postsOnDay, p.day0Date)}. You stay above ${whole(p.checkingFloor)}. Approve? YES or NO`;
}

/** "Done. Car payment is now Fri, Nov 13 ($20). Ref A1B2C3." */
export function doneText(p: { itemLabel: string; toDay: Day; fee: Cents; reference?: string } & DateCtx): string {
  const label = p.itemLabel.charAt(0).toUpperCase() + p.itemLabel.slice(1);
  const fee = p.fee === 0 ? 'no fee' : money(p.fee);
  const ref = p.reference ? ` Ref ${p.reference}.` : '';
  return `Done. ${label} is now ${formatDate(p.toDay, p.day0Date)} (${fee}).${ref}`;
}

/**
 * "Reminder: your $400 car payment and the $20 fee come out tomorrow. Checking will still have $1,680 after."
 * Sent by the watcher from schedule_followup (Thu, Nov 12, 8:00 PM).
 */
export function reminderText(p: { itemLabel: string; amount: Cents; fee: Cents; when: string; balanceAfter: Cents }): string {
  const what = p.fee > 0 ? `your ${whole(p.amount)} ${p.itemLabel} and the ${whole(p.fee)} fee come out` : `your ${whole(p.amount)} ${p.itemLabel} comes out`;
  return `Reminder: ${what} ${p.when}. Checking will still have ${whole(p.balanceAfter)} after.`;
}

// ---------------------------------------------------------------------------
// The CD alert (day 11, unprompted)
// ---------------------------------------------------------------------------

export interface CdAlertParams extends DateCtx {
  cdAmount: Cents;
  maturesOn: Day;
  payoff: Cents; // the card's projected balance on the maturity day
  toSavings: Cents;
  yearlySaved: Cents; // pass rounded ("about $550")
  emergencyBefore: number; // months
  emergencyAfter: number; // months
  renewEarned: Cents; // pass rounded ("about $205")
}

/**
 * Your $5,000 CD matures Fri, Nov 20.
 * 1. Pay off your card ($2,214) and put $2,786 in savings. My pick: saves about $550 a year, and your emergency fund goes from 0.6 to 1.5 months
 * 2. Renew it: earns about $205 a year
 * Reply 1 or 2 and I'll send the steps.
 */
export function cdAlertText(p: CdAlertParams): string {
  return [
    `Your ${whole(p.cdAmount)} CD matures ${formatDate(p.maturesOn, p.day0Date)}.`,
    `1. Pay off your card (${whole(p.payoff)}) and put ${whole(p.toSavings)} in savings. My pick: saves about ${whole(p.yearlySaved)} a year, and your emergency fund goes from ${formatOneDecimal(p.emergencyBefore)} to ${formatOneDecimal(p.emergencyAfter)} months`,
    `2. Renew it: earns about ${whole(p.renewEarned)} a year`,
    "Reply 1 or 2 and I'll send the steps.",
  ].join('\n');
}

/** "Got it. I'll text you the steps Friday morning, when the CD matures." */
export function cdChoiceReplyText(p: { maturesOn: Day } & DateCtx): string {
  return `Got it. I'll text you the steps ${formatWeekdayLong(p.maturesOn, p.day0Date)} morning, when the CD matures.`;
}

// ---------------------------------------------------------------------------
// Chart and status lines (the PNG in iMessage and the Home status line)
// ---------------------------------------------------------------------------

/** "Lowest: −$300 on Tue, Nov 10" (chart PNG title). */
export function chartTitleText(p: { lowest: Lowest } & DateCtx): string {
  return `Lowest: ${money(p.lowest.amount)} on ${formatDate(p.lowest.day, p.day0Date)}`;
}

/** "Checking, next 14 days" */
export function chartSubtitleText(days: number): string {
  return `Checking, next ${days} days`;
}

/** "Lowest −$300 on Tue, Nov 10" (Home status line, also the chart's text label). */
export function statusLineText(p: { lowest: Lowest } & DateCtx): string {
  return `Lowest ${money(p.lowest.amount)} on ${formatDate(p.lowest.day, p.day0Date)}`;
}

// ---------------------------------------------------------------------------
// Paycheck late (what-if by text, the watch, and the real thing)
// ---------------------------------------------------------------------------

export interface PaycheckWhatIfParams extends DateCtx {
  payDay: Day; // when the paycheck is due now
  lateDay: Day; // when it would land instead
  /** The first day checking dips below $0 (or below the minimum when it never goes negative). */
  hit: Lowest | null;
  /** What comes out that day: "the car payment". */
  cause?: string;
  /** hit is below $0 (true) or only under the minimum (false). */
  negative: boolean;
  checkingFloor: Cents;
  /** The 30-day lowest when nothing dips (hit null). */
  lowest: Lowest;
  /** Checking stays below $0 from the hit until the paycheck lands. */
  staysNegative: boolean;
  watch: boolean;
}

/**
 * "If your paycheck lands Monday instead of Thursday, checking would hit −$320 on Fri, Nov 13 when the
 * car payment comes out. I'll watch for it and text you Thursday night if it hasn't landed. Reply NO to skip."
 */
export function paycheckWhatIfText(p: PaycheckWhatIfParams): string {
  const head = `If your paycheck lands ${formatWeekdayLong(p.lateDay, p.day0Date)} instead of ${formatWeekdayLong(p.payDay, p.day0Date)}`;
  if (!p.hit) {
    return `${head}, checking stays above your ${whole(p.checkingFloor)} minimum. The lowest is ${money(p.lowest.amount)} on ${formatDate(p.lowest.day, p.day0Date)}.`;
  }
  const when = p.cause ? ` when ${p.cause} comes out` : '';
  const what = p.negative
    ? `checking would hit ${money(p.hit.amount)} on ${formatDate(p.hit.day, p.day0Date)}${when}${p.staysNegative ? ' and stay negative until it lands' : ''}.`
    : `checking would dip to ${money(p.hit.amount)} on ${formatDate(p.hit.day, p.day0Date)}${when}, under your ${whole(p.checkingFloor)} minimum.`;
  const watch = p.watch ? ` I'll watch for it and text you ${formatWeekdayLong(p.payDay, p.day0Date)} night if it hasn't landed. Reply NO to skip.` : '';
  return `${head}, ${what}${watch}`;
}

/**
 * Sent right after a deal that only works if the next paycheck lands on time:
 * "This works as long as your paycheck lands Thursday. I'll check Thursday night and text you if it hasn't. Reply NO to skip."
 */
export function paycheckDependsText(p: { payDay: Day } & DateCtx): string {
  const day = formatWeekdayLong(p.payDay, p.day0Date);
  return `This works as long as your paycheck lands ${day}. I'll check ${day} night and text you if it hasn't. Reply NO to skip.`;
}

/** Sent by the watcher on payday night (8:00 PM) while the watch is on. */
export function paycheckWatchText(p: { hit: Lowest; payDay: Day } & DateCtx): string {
  return `It's ${formatWeekdayLong(p.payDay, p.day0Date)} night and your paycheck hasn't landed yet. If it's late, checking hits ${money(p.hit.amount)} on ${formatDate(p.hit.day, p.day0Date)}. Text me when it's coming and I'll work on a fix.`;
}

export function paycheckWatchKeptText(): string {
  return "Got it, I'll keep an eye on it.";
}

export function paycheckWatchCancelledText(): string {
  return "Okay, I won't watch for it.";
}

/** "Got it: your paycheck lands Mon, Nov 16 instead of Thu, Nov 12. Checking your week." */
export function paycheckLateAckText(p: { payDay: Day; lateDay: Day } & DateCtx): string {
  return `Got it: your paycheck lands ${formatDate(p.lateDay, p.day0Date)} instead of ${formatDate(p.payDay, p.day0Date)}. Checking your week.`;
}

/** "now that your paycheck lands Mon, Nov 16": the alert's condition for a late paycheck. */
export function paycheckLateCondition(p: { lateDay: Day } & DateCtx): string {
  return `now that your paycheck lands ${formatDate(p.lateDay, p.day0Date)}`;
}

// ---------------------------------------------------------------------------
// The lender changed the terms (during the hold, or after Yoshua approved)
// ---------------------------------------------------------------------------

/** Sent when the lender changes the terms while Yoshua's YES/NO is pending: that question is withdrawn. */
export function dealWithdrawnText(): string {
  return "Hold off on that one: the lender changed the terms while I was checking. I'm still on the call and will check back with you.";
}

/**
 * The deal approval after the lender changed the terms:
 * "The lender changed the fee after you approved $20. They'll move it to Fri, Nov 13 for $25 instead. You stay above $100. Approve? YES or NO"
 */
export function dealChangedApprovalText(
  p: { from: { newDay: Day; fee: Cents }; afterApproval: boolean; toDay: Day; fee: Cents; checkingFloor: Cents } & DateCtx,
): string {
  const dayChanged = p.from.newDay !== p.toDay;
  const feeChanged = p.from.fee !== p.fee;
  const what = dayChanged && feeChanged ? 'terms' : dayChanged ? 'date' : 'fee';
  const was = dayChanged && feeChanged ? `${formatDate(p.from.newDay, p.day0Date)} ${feePhrase(p.from.fee)}` : dayChanged ? formatDate(p.from.newDay, p.day0Date) : p.from.fee === 0 ? 'no fee' : money(p.from.fee);
  const lead = p.afterApproval ? `The lender changed the ${what} after you approved ${was}.` : `The lender changed the ${what} while I was checking (was ${was}).`;
  return `${lead} They'll move it to ${formatDate(p.toDay, p.day0Date)} ${feePhrase(p.fee)} instead. You stay above ${whole(p.checkingFloor)}. Approve? YES or NO`;
}

/**
 * The honest text after a call where the lender changed the terms and PacePay didn't agree:
 * "The lender changed the fee to $35 after you approved $20, so I didn't agree. Nothing changed. Want me to try again?"
 */
export function termsChangedText(
  p: {
    kind: 'terms' | 'extra_fee' | 'condition' | 'walkback';
    /** The terms Yoshua approved (or was being asked about, when approvedByYou is false). */
    approved: { newDay: Day; fee: Cents };
    proposed?: { newDay: Day; fee: Cents };
    approvedByYou: boolean;
    youDeclined?: boolean;
  } & DateCtx,
): string {
  const when = p.approvedByYou ? 'after you approved' : 'while I was checking with you on';
  const terms = (t: { newDay: Day; fee: Cents }) => `${formatDate(t.newDay, p.day0Date)} ${feePhrase(t.fee)}`;
  const fee = (c: Cents) => (c === 0 ? 'no fee' : money(c));
  const tail = p.youDeclined ? ', and you said no, so nothing changed. Want me to try again?' : ", so I didn't agree. Nothing changed. Want me to try again?";
  if (p.kind === 'terms' && p.proposed) {
    const dayChanged = p.proposed.newDay !== p.approved.newDay;
    const feeChanged = p.proposed.fee !== p.approved.fee;
    if (feeChanged && !dayChanged) return `The lender changed the fee to ${fee(p.proposed.fee)} ${when} ${fee(p.approved.fee)}${tail}`;
    if (dayChanged && !feeChanged) return `The lender changed the date to ${formatDate(p.proposed.newDay, p.day0Date)} ${when} ${formatDate(p.approved.newDay, p.day0Date)}${tail}`;
    return `The lender changed the terms to ${terms(p.proposed)} ${when} ${terms(p.approved)}${tail}`;
  }
  if (p.kind === 'walkback') return `The lender took back the ${terms(p.approved)} offer ${p.approvedByYou ? 'after you approved it' : 'while I was checking with you'}, so nothing changed. Want me to try again?`;
  const what = p.kind === 'condition' ? 'added a condition' : 'added another fee';
  return `The lender ${what} ${when} ${terms(p.approved)}${tail}`;
}
