/**
 * Demo mode's state (DemoMachine) and the repair case worked out by the real engine: the base
 * change, the ranked options, the call target, the offer checks, the current plan's changes and
 * the texts PacePay sends. Shared by the reducer (demo-machine.ts) and derive (demo-derive.ts).
 * Owned by: dash-demo.
 */
import {
  ACCOUNT_IDS,
  ITEM_IDS,
  alertText,
  cardOptionText,
  contextItem,
  formatDate,
  formatMoney,
  formatShortDate,
  formatWeekdayLong,
  formatWholeDollars,
  movePaymentOptionText,
  offerVerdict,
  savingsOptionText,
  weekdayOf,
  type ActivityEvent,
  type Change,
  type Day,
  type Forecast,
  type Lowest,
  type Message,
  type OfferCheck,
  type Option,
  type OptionId,
  type Rules,
  type Cents,
} from '@pacepay/shared';
import {
  CASE_DAY,
  balanceOf,
  isMovable,
  repairChange,
  runBestMoveDay,
  runCheck,
  runForecast,
  runOfferChanges,
  runOptions,
  runTargets,
  type OfferTerms,
} from './demo-engine';
import { DISCLOSURE_LINE, lenderScript, offerLabel } from './demo-script';
import type { UiState } from './view-model';

// ---------------------------------------------------------------------------
// The machine's state
// ---------------------------------------------------------------------------

/** The mockup's stages; heads up is 'home'. */
export type Stage = 'home' | 'limits' | 'call' | 'approve' | 'done';

/**
 * The paycheck-late follow-up (v2.md demo script 5-6), after the case is done: 'watching' once
 * PacePay has answered "What if my paycheck is late?" (Reply NO stops it), 'late' once Yoshua says
 * it will be: the late paycheck is then part of the forecast and the panel is a new Heads up.
 */
export type PaycheckState = 'on_time' | 'watching' | 'late';

export interface CallLine {
  who: 'pacepay' | 'lender';
  text: string;
  offer?: OfferTerms;
  /** PacePay's last line: a deal to bring to Yoshua, or no deal. */
  closing?: 'deal' | 'no_deal';
}

export interface DemoMachine {
  ui: UiState;
  day: Day; // 0 or 11
  rules: Rules;
  billAmount: Cents;
  stage: Stage;
  chosen: OptionId | null;
  lines: CallLine[];
  lenderPos: number; // scripted lender lines used
  textMode: boolean;
  deal: OfferTerms | null; // the offer awaiting Yoshua's OK, then the one accepted
  cdOpen: boolean;
  cdAnswered: boolean;
  paycheck: PaycheckState;
  thread: Message[];
  activity: ActivityEvent[];
  seq: number;
  minute: number; // the demo clock, minutes after 7:00 PM on day 0
  notice: string | null;
}

export const inCall = (m: DemoMachine) => m.stage === 'call' || m.stage === 'approve';

// ---------------------------------------------------------------------------
// The case, from the engine
// ---------------------------------------------------------------------------

export const ITEM_LABEL = 'car payment';
export const CAR_PAYMENT_DAY: Day = 3; // Tue, Nov 10: the payment the call moves

export function baseChanges(m: Pick<DemoMachine, 'rules' | 'billAmount'>): Change[] {
  return [repairChange(m.rules, m.billAmount)];
}

/** The 30-day lowest with the repair paid today (the Heads up number). */
export function caseForecast(m: Pick<DemoMachine, 'rules' | 'billAmount'>): Forecast {
  return runForecast(m.rules, baseChanges(m), CASE_DAY, 30);
}

export function needsHelp(m: Pick<DemoMachine, 'rules' | 'billAmount'>): boolean {
  return caseForecast(m).lowest.amount < m.rules.checkingFloor;
}

/** The day PacePay asks for (Fri, Nov 13), or -1 when no day works. */
export function targetDay(m: Pick<DemoMachine, 'rules' | 'billAmount'>): Day {
  return runTargets(m.rules, baseChanges(m)).targetDay;
}

/** The options in the order texted: moving the payment first when it clears the floor (no new debt). */
export function rankedOptions(m: Pick<DemoMachine, 'rules' | 'billAmount'>): Option[] {
  const opts = runOptions(m.rules, m.billAmount);
  const score = (o: Option) => {
    if (o.id === 'move_payment') return o.violations.length ? 3 : 0;
    if (o.id === 'card') return o.violations.length ? 4 : 1;
    return o.violations.length ? 5 : 2;
  };
  return [...opts].sort((a, b) => score(a) - score(b));
}

export function findOption(m: Pick<DemoMachine, 'rules' | 'billAmount'>, id: OptionId): Option | undefined {
  return rankedOptions(m).find((o) => o.id === id);
}

export function checkFor(m: Pick<DemoMachine, 'rules' | 'billAmount'>, offer: OfferTerms): OfferCheck {
  return runCheck(m.rules, baseChanges(m), offer);
}

type PlanInput = Pick<DemoMachine, 'rules' | 'billAmount' | 'stage' | 'chosen' | 'deal'>;

/** What Yoshua agreed to: the repair paid today, then whatever he approved. */
export function agreedChanges(m: PlanInput): Change[] {
  const base = baseChanges(m);
  if (m.stage !== 'done' || !m.chosen) return base;
  if (m.chosen === 'move_payment' && m.deal) return [...base, ...runOfferChanges(m.rules, m.deal)];
  return findOption(m, m.chosen)?.changes ?? base;
}

/** The current plan's changes: what Yoshua agreed to, plus the late paycheck once he says it is late. */
export function planChanges(m: PlanInput & Partial<Pick<DemoMachine, 'paycheck'>>): Change[] {
  const agreed = agreedChanges(m);
  const late = m.paycheck === 'late' ? latePaycheck(m) : null;
  return late ? [...agreed, late.change] : agreed;
}

/** The cash moved from savings in the savings option. */
export function savingsAmount(o: Option): Cents {
  const t = o.changes.find((c) => c.type === 'transfer');
  return t && t.type === 'transfer' ? t.amount : 0;
}

// ---------------------------------------------------------------------------
// The late paycheck (v2.md demo script 5-6): Thursday's paycheck lands Monday
// ---------------------------------------------------------------------------

/** Thu -> Mon, the same late paycheck as the what-if panel's row. */
export const PAYCHECK_LATE_DAYS = 4;

/** The first day in `fc` a paycheck lands. */
export function nextPayday(fc: Forecast): Day | null {
  return fc.days.find((d) => d.items.some((it) => it.itemId.startsWith(ITEM_IDS.paycheck) && it.amount > 0))?.day ?? null;
}

export interface LatePaycheck {
  payday: Day;
  late: Day;
  change: Change;
  /** 30 days from the case day with what Yoshua agreed to and the paycheck late. */
  forecast: Forecast;
  agreed: Change[];
}

/** The next paycheck moved PAYCHECK_LATE_DAYS later, on top of what Yoshua agreed to. */
export function latePaycheck(m: PlanInput): LatePaycheck | null {
  const agreed = agreedChanges(m);
  const payday = nextPayday(runForecast(m.rules, agreed, CASE_DAY, 30));
  if (payday === null) return null;
  const late = payday + PAYCHECK_LATE_DAYS;
  const change: Change = { type: 'move_item', itemId: ITEM_IDS.paycheck, toDay: late };
  return { payday, late, change, agreed, forecast: runForecast(m.rules, [...agreed, change], CASE_DAY, 30) };
}

/** "What if my paycheck is late?" -> 'what_if'; "My paycheck is going to be late" -> 'late'. */
export function paycheckIntent(text: string): 'what_if' | 'late' | null {
  const t = text.toLowerCase();
  if (!/\b(pay ?check|payday)\b/.test(t) || !/\b(late|delayed)\b/.test(t)) return null;
  return /\bwhat if\b|\?\s*$/.test(t) ? 'what_if' : 'late';
}

/** "the car payment comes out" / "the mortgage and the utilities come out": a day's debits, fees left out. */
function comesOut(fd: Forecast['days'][number]): string {
  const debits = fd.items.filter((it) => it.amount < 0);
  const named = debits.filter((it) => !it.itemId.startsWith('fee'));
  const labels = [...new Set((named.length ? named : debits).map((it) => it.label.toLowerCase()))];
  if (!labels.length) return '';
  const plural = labels.length > 1 || /[^s]s$/.test(labels[0]!); // "the utilities come out"
  return ` when the ${labels.join(' and the ')} ${plural ? 'come' : 'comes'} out`;
}

/**
 * PacePay's answer to "What if my paycheck is late?", from the engine: the first day checking goes
 * below $0 (or under the minimum) with the paycheck late, and the offer to watch for it.
 */
export function paycheckAnswer(m: PlanInput): { text: string; log: string; watch: boolean } | null {
  const lp = latePaycheck(m);
  if (!lp) return null;
  const floor = m.rules.checkingFloor;
  const lead = `If your paycheck lands ${formatWeekdayLong(lp.late)} instead of ${formatWeekdayLong(lp.payday)}`;
  const days = lp.forecast.days;
  const overdrawn = days.find((d) => d.intradayLow < 0);
  const under = overdrawn ?? days.find((d) => d.intradayLow < floor);
  const logHead = `Paycheck on ${formatDate(lp.late)}`;
  if (!under) {
    const low = lp.forecast.lowest;
    return {
      text: `${lead}, checking stays above your ${whole(floor)} minimum: lowest ${money(low.amount)} on ${formatDate(low.day)}.`,
      log: `${logHead}: lowest ${money(low.amount)}, above the minimum`,
      watch: false,
    };
  }
  const at = `${money(under.intradayLow)} on ${formatDate(under.day)}`;
  const what = overdrawn ? `checking would hit ${at}` : `checking would drop to ${at}, under your ${whole(floor)} minimum,`;
  const watch = `I'll watch for it and text you ${formatWeekdayLong(lp.payday)} night if it hasn't landed. Reply NO to skip.`;
  return {
    text: `${lead}, ${what}${comesOut(under)}. ${watch}`.replace(',.', '.'),
    log: `${logHead}: checking hits ${at}`,
    watch: true,
  };
}

export interface LateOption {
  id: 'move_payment' | 'savings';
  /** Panel row. */
  title: string;
  detail: string;
  /** The alert's option line. */
  text: string;
}

export interface LateCase {
  late: LatePaycheck;
  lowest: Lowest;
  options: LateOption[];
  /** The Heads up text, call first. */
  alert: string;
  optionsLog: string;
}

/**
 * The new Heads up once the paycheck is late, worked out by the engine: move the payment behind
 * the dip past the late payday (with whatever savings top-up it still needs), or cover it all
 * from savings. Null when checking stays above the minimum anyway.
 */
export function lateCase(m: PlanInput): LateCase | null {
  const lp = latePaycheck(m);
  if (!lp) return null;
  const r = m.rules;
  const fc = lp.forecast;
  if (fc.lowest.amount >= r.checkingFloor) return null;
  const base = [...lp.agreed, lp.change];
  const savings = balanceOf(r, ACCOUNT_IDS.savings);
  const options: LateOption[] = [];
  let callLog = 'No payment can move far enough.';

  // 1. The call: the soonest movable payment behind the dip, moved past the late payday.
  const target = fc.lowest.causeItemIds.find((id) => isMovable(r, base, id));
  const move = target ? runBestMoveDay(r, base, target, lp.late) : null;
  if (target && move) {
    const label = fc.days.flatMap((d) => d.items).find((it) => it.itemId === target)?.label.toLowerCase() ?? ITEM_LABEL;
    const topUp = Math.max(0, r.checkingFloor - move.lowest.amount);
    const after = savings - topUp;
    const plus = topUp > 0 ? `With ${whole(topUp)} from savings. ` : '';
    options.push({
      id: 'move_payment',
      title: `Move your ${label} to ${weekdayOf(move.day)}`,
      detail: `${plus}Stays above ${whole(r.checkingFloor)}. Fee up to ${whole(r.feeLimit)}.`,
      text: `${movePaymentOptionText({ itemLabel: label, toDay: move.day })}${topUp > 0 ? ` and you move ${whole(topUp)} from savings` : ''}`,
    });
    callLog = `Moving the ${label} to ${formatDate(move.day)}${topUp > 0 ? ` plus ${whole(topUp)} from savings` : ''} ${after >= r.savingsFloor ? 'works' : 'dips into the savings floor'}.`;
  }

  // 2. Savings alone: the whole shortfall up to the minimum.
  const shortfall = r.checkingFloor - fc.lowest.amount;
  const below = savings - shortfall < r.savingsFloor;
  options.push({
    id: 'savings',
    title: `Use ${whole(shortfall)} of savings`,
    detail: `${below ? 'Below' : 'Stays above'} your ${whole(r.savingsFloor)} floor`,
    text: savingsOptionText({ amount: shortfall, savingsFloor: r.savingsFloor, belowFloor: below }),
  });

  // The dip's causes after the original payday (what that paycheck was going to cover).
  const context: string[] = [];
  const seen = new Set<string>();
  for (const fd of fc.days) {
    if (fd.day <= lp.payday) continue;
    for (const it of fd.items) {
      if (!fc.lowest.causeItemIds.includes(it.itemId) || it.itemId.startsWith('fee') || seen.has(it.label)) continue;
      seen.add(it.label);
      context.push(contextItem(it.label.toLowerCase(), fd.day));
    }
  }

  const optionsLog = `${callLog} ${below ? 'Savings alone drops below the floor.' : 'Savings alone stays above the floor.'}`;

  return {
    late: lp,
    lowest: { amount: fc.lowest.amount, day: fc.lowest.day },
    options,
    alert: alertText({
      lowest: fc.lowest,
      condition: `if your paycheck lands ${formatWeekdayLong(lp.late)}`,
      context,
      options: options.map((o) => o.text),
      pickReason: options[0]?.id === 'move_payment' ? 'no new debt' : 'checking stays covered',
    }),
    optionsLog,
  };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const money = (c: Cents) => formatMoney(c);
const whole = (c: Cents) => formatWholeDollars(c);

/** The Heads up panel and alert rows for one option. */
export function optionRow(m: Pick<DemoMachine, 'rules' | 'billAmount'>, o: Option): { title: string; detail: string; cta: string; text: string } {
  const r = m.rules;
  if (o.id === 'move_payment') {
    const to = targetDay(m);
    const stays = o.lowest.amount >= r.checkingFloor;
    return {
      title: `Move your ${ITEM_LABEL} to ${weekdayOf(to)}`,
      detail: `${stays ? 'Stays above' : 'Drops below'} ${whole(r.checkingFloor)}. Fee up to ${whole(r.feeLimit)}.`,
      cta: 'Ask my lender',
      text: movePaymentOptionText({ itemLabel: ITEM_LABEL, toDay: to }),
    };
  }
  if (o.id === 'card') {
    const interest = o.tradeoffs.monthlyInterest ?? 0;
    return {
      title: 'Put it on your card',
      detail: `About ${whole(interest)}/mo interest`,
      cta: 'Use my card',
      text: cardOptionText({ monthlyInterest: interest }),
    };
  }
  const amount = savingsAmount(o);
  const below = o.violations.includes('BELOW_SAVINGS_FLOOR');
  return {
    title: `Use ${whole(amount)} of savings`,
    detail: `${below ? 'Below' : 'Stays above'} your ${whole(r.savingsFloor)} floor`,
    cta: 'Use savings',
    text: savingsOptionText({ amount, savingsFloor: r.savingsFloor, belowFloor: below }),
  };
}

/** "mortgage Mon", "car payment Tue", "paycheck Thu": the dip's causes and the payday after it. */
function alertContext(fc: Forecast): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const fd of fc.days) {
    for (const it of fd.items) {
      if (fc.lowest.causeItemIds.includes(it.itemId) && !seen.has(it.itemId)) {
        seen.add(it.itemId);
        out.push(contextItem(it.label.toLowerCase(), fd.day));
      }
    }
  }
  const payday = fc.days.find((fd) => fd.day > fc.lowest.day && fd.items.some((it) => it.amount > 0));
  if (payday) {
    const pay = payday.items.find((it) => it.amount > 0)!;
    out.push(contextItem(pay.label.toLowerCase(), payday.day));
  }
  return out;
}

function pickReason(o: Option): string {
  return o.id === 'card' ? 'checking stays covered' : 'no new debt';
}

/** The alert text with options (UI.md iMessage), or the all-clear when the bill fits. */
export function alertMessage(m: Pick<DemoMachine, 'rules' | 'billAmount'>): string {
  const fc = caseForecast(m);
  if (!needsHelp(m)) return `Checked your week: lowest ${money(fc.lowest.amount)} on ${formatDate(fc.lowest.day)}. You're covered.`;
  const opts = rankedOptions(m);
  return alertText({
    lowest: fc.lowest,
    condition: 'if you pay the repair today',
    context: alertContext(fc),
    options: opts.map((o) => optionRow(m, o).text),
    pickReason: opts[0] ? pickReason(opts[0]) : '',
  });
}

/** "Lowest −$300 on Tue, Nov 10, from the mortgage and the car payment" */
export function lowestLogLine(fc: Forecast): string {
  const labels: string[] = [];
  for (const fd of fc.days) for (const it of fd.items) if (fc.lowest.causeItemIds.includes(it.itemId) && !labels.includes(it.label.toLowerCase())) labels.push(it.label.toLowerCase());
  const from = labels.length ? `, from the ${labels.join(' and the ')}` : '';
  return `Lowest ${money(fc.lowest.amount)} on ${formatDate(fc.lowest.day)}${from}`;
}

/** "Moving the payment works. The card costs about $14/mo. Savings drops below the floor." */
export function optionsLogLine(m: Pick<DemoMachine, 'rules' | 'billAmount'>): string {
  const parts: string[] = [];
  const order: OptionId[] = ['move_payment', 'card', 'savings'];
  const opts = [...runOptions(m.rules, m.billAmount)].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  for (const o of opts) {
    if (o.id === 'move_payment') parts.push(o.violations.length ? "Moving the payment doesn't clear it." : 'Moving the payment works.');
    if (o.id === 'card') parts.push(`The card costs about ${whole(o.tradeoffs.monthlyInterest ?? 0)}/mo.`);
    if (o.id === 'savings') parts.push(o.violations.includes('BELOW_SAVINGS_FLOOR') ? 'Savings drops below the floor.' : 'Savings stays above the floor.');
  }
  if (!parts.some((p) => p.startsWith('Moving'))) parts.unshift('No payment can move far enough.');
  return parts.join(' ');
}

/** The Activity log's verdict: "works", "fails, overdrawn", "fails, over your fee limit". */
export function verdictLog(check: OfferCheck): string {
  switch (offerVerdict(check)) {
    case 'Works':
      return 'works';
    case 'Overdrawn':
      return 'fails, overdrawn';
    case 'Payday':
      return 'fails, lands on payday';
    case 'Below minimum':
      return 'fails, below your minimum';
    default:
      return 'fails, over your fee limit';
  }
}

export function checkedLogLine(o: OfferTerms, check: OfferCheck): string {
  return `Checked "${offerLabel(o)}": ${verdictLog(check)}`;
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export function lastOffer(lines: CallLine[]): OfferTerms | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) if (lines[i]!.offer) return lines[i]!.offer!;
  return null;
}

export function openingLine(): CallLine {
  return { who: 'pacepay', text: DISCLOSURE_LINE };
}

/** PacePay's answer to the lender's last line, from the engine's verdict on any offer in it. */
export function pacepayReply(m: DemoMachine, lender: CallLine): CallLine {
  const to = targetDay(m);
  const asked = m.lines.some((l) => l.who === 'pacepay' && l.text.startsWith('Can the '));
  if (!lender.offer) {
    if (!asked) return { who: 'pacepay', text: `Can the ${formatShortDate(CAR_PAYMENT_DAY)} payment move to ${formatDate(to)}?` };
    return { who: 'pacepay', text: 'What date and fee can you do?' };
  }
  const o = lender.offer;
  const check = checkFor(m, o);
  if (check.pass) {
    const fee = o.fee ? `with a ${whole(o.fee)} fee` : 'with no fee';
    return { who: 'pacepay', text: `${weekdayOf(o.newDay)} ${fee}. Let me check with Yoshua.`, closing: 'deal' };
  }
  const verdict = offerVerdict(check);
  if (verdict === 'Over limit') return { who: 'pacepay', text: 'Could you waive the fee?' };
  if (o.newDay === to) return { who: 'pacepay', text: "That won't work for Yoshua. Is a later date possible?" };
  return { who: 'pacepay', text: `${formatDate(o.newDay)}? That won't work. Is ${formatWeekdayLong(to)} possible?` };
}

/** The line the "Next line" control reveals next, or null when the call is ready to end. */
export function nextCallLine(m: DemoMachine): CallLine | null {
  const last = m.lines[m.lines.length - 1];
  if (!last) return openingLine();
  if (last.closing) return null;
  if (last.who === 'lender') return pacepayReply(m, last);
  const script = lenderScript();
  const next = script[m.lenderPos];
  if (!next) return { who: 'pacepay', text: "Thanks for your time. I'll let Yoshua know.", closing: 'no_deal' };
  return { who: 'lender', text: next.text({ offer: next.offer }), offer: next.offer };
}

export function lowestOf(fc: Forecast, days: number): Lowest {
  let lo = fc.days[0]!;
  for (const fd of fc.days.slice(0, days)) if (fd.intradayLow < lo.intradayLow) lo = fd;
  return { amount: lo.intradayLow, day: lo.day };
}
