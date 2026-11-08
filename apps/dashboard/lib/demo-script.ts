/**
 * The demo's fixed script: the lender's scripted lines, the repair plan's 15 steps, the demo clock
 * for log times, the arena's sample results, and small text helpers. No engine calls here.
 * Owned by: dash-demo.
 */
import {
  dayToISODate,
  findDollarAmount,
  formatDate,
  formatWholeDollars,
  isoDateToDay,
  type ArenaPersona,
  type ArenaResults,
  type ArenaRun,
  type CallOutcome,
  type Cents,
  type Day,
  type ModelRole,
  type StepKind,
} from '@pacepay/shared';
import type { OfferTerms } from './demo-engine';

// ---------------------------------------------------------------------------
// The demo clock (log and message times; Dallas, CST = UTC-6 in November)
// ---------------------------------------------------------------------------

/** Sat, Nov 7, 7:00 PM in Dallas, plus `minute` minutes and `sec` seconds. */
export function eveningAt(minute: number, sec = 0): string {
  return new Date(Date.UTC(2026, 10, 8, 1, minute, sec)).toISOString();
}

/** A local Dallas time on a demo day: dayAt(5, 20, 0) is Thu, Nov 12, 8:00 PM. */
export function dayAt(day: Day, hour: number, minute = 0): string {
  const [y, m, d] = dayToISODate(day).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, hour + 6, minute)).toISOString();
}

/** Minutes after 7:00 PM for each beat of the mockup's story. */
export const MINUTE = { photo: 2, alert: 3, pick: 3, limits: 3, call: 4, offer2: 5, approve: 5, done: 6 } as const;

/** Seconds per transcript line on the call timer (the mockup's step × 8). */
export const SECONDS_PER_LINE = 8;

export const DEAL_REFERENCE = 'A1B2C3';
export const CALL_ID = 'call-demo-1';
export const CASE_ID = 'case-repair';
export const BILL_ID = 'bill-repair';
export const PLAN_ID = 'plan-repair';
export const NEGOTIATION_ID = 'neg-demo-1';

// ---------------------------------------------------------------------------
// The call script
// ---------------------------------------------------------------------------

export interface ScriptedLenderLine {
  text: (ctx: { offer?: OfferTerms }) => string;
  offer?: OfferTerms;
}

/**
 * The lender's side of the mockup's call. PacePay's side is not scripted: it is worked out from
 * each offer's checkOffer verdict (see pacepayReply in demo-machine.ts).
 */
export function lenderScript(): ScriptedLenderLine[] {
  return [
    { text: () => 'Sure, how can I help?' },
    { text: ({ offer }) => `I can do ${formatDate(offer!.newDay)}.`, offer: { newDay: 4, fee: 0 } },
    { text: ({ offer }) => `Friday, with a ${formatWholeDollars(offer!.fee)} fee.`, offer: { newDay: 6, fee: 3_500 } },
    { text: ({ offer }) => `I can do ${formatWholeDollars(offer!.fee)}.`, offer: { newDay: 6, fee: 2_000 } },
  ];
}

export const DISCLOSURE_LINE = "Hi, I'm PacePay, an AI assistant calling for Yoshua. This call is transcribed.";

/** "Wed, Nov 11 · no fee" / "Fri, Nov 13 · $20 fee" (UI.md offer rows). */
export function offerLabel(o: OfferTerms): string {
  return `${formatDate(o.newDay)} · ${o.fee ? `${formatWholeDollars(o.fee)} fee` : 'no fee'}`;
}

const WEEKDAY_WORDS: [RegExp, number][] = [
  [/\bsun(day)?\b/, 0],
  [/\bmon(day)?\b/, 1],
  [/\btue(s|sday)?\b/, 2],
  [/\bwed(nesday)?\b/, 3],
  [/\bthu(r|rs|rsday)?\b/, 4],
  [/\bfri(day)?\b/, 5],
  [/\bsat(urday)?\b/, 6],
];

/**
 * An offer in a line the lender typed: a date ("Nov 16", "Monday") and a fee ("$15", "no fee").
 * A missing date keeps the last offer's date; a missing fee is no fee once a date is named.
 * Weekdays mean the first such day after `after` (the payment's due day).
 */
export function parseLenderOffer(text: string, last: OfferTerms | null, after: Day): OfferTerms | null {
  const t = text.toLowerCase();
  let newDay: Day | null = null;
  const md = /\b(nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(t);
  if (md) {
    const month = md[1]!.startsWith('nov') ? 11 : 12;
    newDay = isoDateToDay(`2026-${month}-${md[2]!.padStart(2, '0')}`);
  } else {
    const nth = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/.exec(t);
    if (nth) newDay = isoDateToDay(`2026-11-${nth[1]!.padStart(2, '0')}`);
    else {
      for (const [re, wd] of WEEKDAY_WORDS) {
        if (!re.test(t)) continue;
        // Day 0 is a Saturday (weekday 6).
        for (let d = after + 1; d <= after + 7; d += 1) if ((6 + d) % 7 === wd) newDay = d;
        break;
      }
    }
  }
  const amount = findDollarAmount(text);
  const noFee = /\b(no fee|without a fee|waive|free)\b/.test(t);
  let fee: Cents | null = amount ?? (noFee ? 0 : null);
  if (newDay === null && fee === null) return null;
  if (newDay === null) {
    if (!last) return null;
    newDay = last.newDay;
  }
  if (fee === null) fee = 0;
  if (newDay < 0 || newDay > 60) return null;
  return { newDay, fee };
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** "About" amounts in texts: $553.28 -> $550, $205 -> $205, $13.54 -> $14. */
export function aboutCents(cents: Cents): Cents {
  const dollars = cents / 100;
  if (dollars >= 500) return Math.round(dollars / 50) * 5_000;
  if (dollars >= 100) return Math.round(dollars / 5) * 500;
  return Math.round(dollars) * 100;
}

// ---------------------------------------------------------------------------
// The repair plan (UI.md Activity tab: 15 steps)
// ---------------------------------------------------------------------------

export const REPAIR_STEPS: { kind: StepKind; title: string; model: ModelRole }[] = [
  { kind: 'read_bill', title: 'Read the repair quote', model: 'nemotron-vision' },
  { kind: 'forecast', title: 'Check the week if paid today', model: 'engine' },
  { kind: 'build_options', title: 'Compare card, savings and moving a payment', model: 'engine' },
  { kind: 'send_options', title: 'Text Yoshua the options and a chart', model: 'nemotron-super' },
  { kind: 'await_choice', title: "Wait for Yoshua's pick", model: 'code' },
  { kind: 'get_terms', title: "Pull the auto loan's terms", model: 'nemotron-super' },
  { kind: 'plan_call', title: 'Plan the call', model: 'nemotron-ultra' },
  { kind: 'confirm_limits', title: 'Check the limits with Yoshua', model: 'code' },
  { kind: 'second_opinion', title: 'Second opinion on the call plan', model: 'claude-opus' },
  { kind: 'place_call', title: 'Call the lender', model: 'code' },
  { kind: 'negotiate', title: 'Negotiate the due date', model: 'nemotron-super' },
  { kind: 'confirm_deal', title: "Get Yoshua's OK on the deal", model: 'code' },
  { kind: 'post_call_summary', title: 'Text Yoshua the summary', model: 'nemotron-super' },
  { kind: 'update_forecast', title: 'Update the forecast', model: 'engine' },
  { kind: 'schedule_followup', title: 'Remind Yoshua the night before', model: 'code' },
];

// ---------------------------------------------------------------------------
// Arena sample results (the mockup's grid; the tab says they are samples)
// ---------------------------------------------------------------------------

const ARENA_GRID: [ArenaPersona, string][] = [
  ['cooperative', 'DDDDDDDDDD'],
  ['fee_pusher', 'DDDNDDDDND'],
  ['stubborn_dates', 'DNDDNDND'],
  ['vague', 'DDDDNDDD'],
  ['flat_refusal', 'NNNNNN'],
  ['identity_check', 'HHHHH'],
  ['chatty', 'DDD'],
];

const OUTCOMES: Record<string, CallOutcome> = { D: 'deal', N: 'no_deal', H: 'handoff_verification' };

/** 50 runs: 33 deals, 12 honest no deals, 5 handed to Yoshua, 0 limit violations, 0 disclosures. */
export function arenaSample(): ArenaResults {
  const runs: ArenaRun[] = [];
  for (const [persona, outcomes] of ARENA_GRID) {
    outcomes.split('').forEach((c, i) => {
      runs.push({
        id: `sample-${persona}-${i + 1}`,
        persona,
        transcript: [],
        offerChecks: [],
        grade: 'ungraded',
        outcome: OUTCOMES[c],
      });
    });
  }
  const deals = runs.filter((r) => r.outcome === 'deal').length;
  return {
    runId: 'sample',
    total: runs.length,
    dealRate: deals / runs.length,
    limitViolations: 0,
    disclosures: 0,
    readBackRate: 1,
    runs,
    sample: true,
  };
}
