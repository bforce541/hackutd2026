/**
 * SPEC §5.6 "How decide works": the ReAct loop around Nano with code-enforced steps
 * (read-back before check_offer, approval before any deal, counters chosen by code from the
 * CallPlan, never stating reasons or limits). Implemented by: negotiator.
 * Used by tools/decide.ts, the lender console (api/negotiations.ts), the voice API and the arena.
 *
 * Who creates what:
 * - The orchestrator's plan_call step (agent-core) creates the Negotiation: state 'opening',
 *   channel 'voice', callPlan from engine.planCallTargets plus Ultra's wording, transcript [],
 *   and publishes SSE `negotiation` (the Limits panel reads targetDay and feeLimit from it).
 * - place_call sets negotiation.callId; CALL_FAILED switches channel to 'text'.
 * - decide() is the only writer after that: it appends every lender utterance and every line it
 *   returns to negotiation.transcript, records offers and checks (runTool('check_offer'); the tool
 *   itself passes store.forecastChanges() as the engine's baseChanges), requests the deal approval through
 *   runTool('request_approval', { kind: 'deal', timeoutMs: DEAL_APPROVAL_TIMEOUT_MS,
 *   negotiationId, callId }), and publishes `negotiation` after every change.
 * - When the negotiation closes it enqueues CALL_ENDED so the case moves to SUMMARIZING.
 *
 * How it behaves (code, not the model):
 * - On a call the voice worker speaks decide's `say` verbatim, so every line comes from here.
 * - Code reads the lender's words first (readInCode): yes/no, offers with a day and/or a fee in any
 *   wording or speech-to-text mangling ("How it works, but there's a $35 fee" = Friday works, $35),
 *   repeats, holds, questions. Those turns take a few ms. Only lines code can't read go to the model
 *   (job 'decide'), capped at 2.5 s on a call with a code fallback; code still sets day and fee.
 * - A day or fee left out comes from context (what PacePay last asked, the read-back, the last offer).
 * - Every new offer is read back ("Okay, so just to confirm, that's Friday the 13th with a
 *   twenty-dollar fee?"). The read-back's terms said again, in any wording, confirm it; a clear yes to
 *   a counter that stated its day and fee accepts it. check_offer runs only after that.
 * - Pass -> deal approval (60 s); the hold line goes out at once. Fail -> a counter chosen here: a
 *   fee waiver first when only the fee fails, then a lower fee, otherwise always the CallPlan's
 *   targetDay with no fee, unless the lender turned that day down; then the next acceptable day.
 *   Terms already checked and said again are a no to the last ask (the next counter, never the same
 *   read-back again). PacePay never refuses an offer or speaks for Yoshua; no line ever states a
 *   reason, a balance, a floor or the fee limit.
 * - Every line has 2-4 code-written variants (LINES, vary()) so nothing repeats word-for-word.
 * - Closing: after a deal, a verification request or an approval timeout PacePay asks for a
 *   reference number (outcome set, state still 'listening'), captures it however it's spoken, asks
 *   once more if none came, then closes. A reference given early is kept and said back at the end.
 *   The approval outcome line goes out on a call exactly once (decide or the worker's poll).
 * - The confirmed deal's changes are NOT added to acceptedChanges here: the orchestrator commits
 *   them on CALL_ENDED, and only when confirmedDeal() says the deal stands (dealChanges() gives the list).
 *
 * The safety contract (code, not the model):
 * - PacePay agrees only to the exact day + fee Yoshua approved. Hedged answers ("yeah, something like
 *   that", "I think so", "about twenty") get the exact terms read back; only a clear yes confirms.
 * - A change after Yoshua's yes (or during the hold) voids it: PacePay restates the approved terms and
 *   asks the lender to honor them. If they insist on new terms within limits (check_offer passes), the
 *   old approval is withdrawn and Yoshua gets a fresh one (dealChangedApprovalText) while PacePay holds;
 *   over limits, a condition, or a walk-back: a neutral goodbye that says nothing was agreed, no deal.
 * - On a live call CALL_ENDED waits for the worker's 'ended' event (callHungUp); a change said during
 *   the goodbye still voids the deal. The Done text, the forecast and the paycheck text follow only a
 *   deal that is undisputed when the call ends; otherwise post_call_summary sends termsChangedText.
 *
 * Dashboard fields ("the lender changed the terms" screen), all add-only in @pacepay/shared:
 * - Negotiation.termsChange?: { kind: 'terms' | 'extra_fee' | 'condition' | 'walkback',
 *     previousTerms: { newDay, fee }  // what Yoshua approved (or was being asked about)
 *     newTerms?: { newDay, fee }      // the lender's new terms, when named
 *     afterApproval: boolean          // true when Yoshua had already said yes to previousTerms
 *     status: 'asking_lender' | 'awaiting_yoshua' | 'yoshua_approved' | 'yoshua_declined' | 'resolved' | 'no_deal'
 *     approvalId?: string             // the fresh deal approval sent for newTerms
 *     at: ISO timestamp }
 * - Negotiation.closeReason?: string  // plain words, set on every explained no-deal close, e.g.
 *     "The lender changed the fee to $35 after Yoshua approved $20. PacePay didn't agree. Nothing changed."
 * - Approval.previousTerms? / Approval.newTerms?: { newDay, fee } on the re-approval only.
 *   A withdrawn approval has status 'timeout' and answer 'withdrawn'.
 * - DecideResult.dtmf?: string  // digits for an IVR menu (situations.ts); send instead of speaking `say`.
 */
import { z } from 'zod';
import {
  DEAL_APPROVAL_TIMEOUT_MS,
  dealApprovalText,
  dealChangedApprovalText,
  dollarsToCents,
  findDollarAmount,
  formatDate,
  formatMoney,
  formatShortDate,
  formatWeekdayLong,
  isoDateToDay,
  dayToISODate,
  normalizeReply,
  weekdayOf,
  type Change,
  type Cents,
  type Day,
  type DecideResult,
  type Negotiation,
  type Offer,
  type OfferCheck,
  type TranscriptLine,
  type VoiceApprovalResponse,
  type Weekday,
} from '@pacepay/shared';
import { newId } from '../ids';
import { loadPrompt } from '../prompts/load';
import { runTool, type ToolContext, type ToolScope } from '../tools/registry';
import { timeoutApproval } from '../approvals';
import { detectSituation, type SituationPhase } from './situations';
import { DEFAULT_TIMEOUTS, type ChatMessage } from '../models';
import { isScriptedNegotiation, openingLine as scriptedOpeningLine, scriptedApprovalOutcome, scriptedDecide } from './stub';

const TEXT_DECIDE_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Lines PacePay says (no reasons, balances, floors or limits in any of them)
// ---------------------------------------------------------------------------

/**
 * Every line PacePay says comes from here, in 2-4 variants. vary() picks one by turn and skips any
 * variant already said in this negotiation, so nothing repeats word-for-word in a call. Amounts and
 * dates are spoken ("a twenty-dollar fee", "Friday the 13th"); none of them comes from the model.
 */
const LINES = {
  checkingWithYoshua: [
    'Let me confirm that with Yoshua.',
    'Thanks, let me run that by Yoshua real quick.',
    "Okay, I'll check with Yoshua. Bear with me.",
    "Thanks. Let me get Yoshua's okay on that.",
  ],
  stillHolding: [
    "Thanks for holding, I'm still checking with Yoshua.",
    "Still checking with Yoshua, thanks for your patience.",
    "Thanks for bearing with me, I'm still checking with Yoshua.",
    "Just a little longer, I'm still checking with Yoshua.",
  ],
  clarifyDay: ['Which exact day would that be?', "Sorry, which day exactly?", 'Could you give me the exact day?'],
  clarifyOffer: [
    'Sorry, I want to get this right. What day and fee are you offering?',
    "Sorry about that. What's the day and the fee you're offering?",
    'Let me make sure I have it. What day and fee would that be?',
  ],
  whatDay: ['Is there a day you could move it to?', 'Okay. Is there another day that would work?', 'Understood. What day could you move it to?'],
  waiver: [
    'Got it. Is there any way to waive that fee?',
    'I see. Would you be able to waive the fee?',
    'Okay. Could you waive the fee on that one?',
    "Understood. Is there any chance you'd waive the fee?",
  ],
  lowerFee: ['Is there any way to bring that fee down?', 'Could you lower the fee at all?', 'Is there any flexibility on the fee?'],
  whatFee: ['Okay. How much would the fee be?', 'Got it. What would the fee be?', 'Sure. And how much is the fee?'],
  noDeal: [
    "Thanks for checking. Nothing is agreed today, so the payment stays as it is. Yoshua can follow up with you directly. Goodbye.",
    "Thanks for looking into it. We haven't agreed to anything today, and Yoshua can follow up with you directly. Goodbye.",
    "I appreciate you checking. Nothing is agreed today; Yoshua will follow up with you directly. Take care, goodbye.",
  ],
  refusal: [
    "I understand. So nothing changes today. Thank you for your time; I'll let Yoshua know. Goodbye.",
    "Understood, so nothing changes today. Thanks for your time, I'll let Yoshua know. Goodbye.",
    "Got it, nothing changes today. Thanks for your time; I'll pass that along to Yoshua. Goodbye.",
  ],
  verification: [
    "I understand. I can't verify on Yoshua's behalf, so Yoshua will contact you directly. Could I get a reference number for this request?",
    "That makes sense. I'm not able to verify for Yoshua, so Yoshua will reach out directly. Could I get a reference number for this request?",
  ],
  holdAndReference: [
    "I wasn't able to reach Yoshua just now. Could you hold that offer and give me a reference number? Yoshua will call you back.",
    "Sorry, I couldn't reach Yoshua just yet. Could you hold that offer and give me a reference number? Yoshua will call you back.",
  ],
  waitForReference: ["I'll wait for the reference number.", "No rush, I'll hang on for the reference number.", "Take your time, I'll wait for the reference number."],
  askReferenceAgain: [
    'Sorry, could I get a reference number for that change?',
    'And is there a reference number for that?',
    'Before I go, could I get a reference number?',
  ],
  closeNoReference: [
    'Thank you for your help. Nothing has been changed yet, and Yoshua will follow up. Goodbye.',
    'Thanks for your help. Nothing is changed for now; Yoshua will follow up. Goodbye.',
  ],
  modelFailed: ["Sorry, let me check on that and call you back. Thank you, goodbye."],
  ended: ['This conversation has ended. Thank you.'],
  privateDetails: ["I'm not able to share details about Yoshua's finances.", "I'm sorry, I can't share anything about Yoshua's finances.", "That's not something I can share on Yoshua's behalf."],
  takeYourTime: ['Take your time.', "I'll hold.", "Take your time, I'm here."],
  /** Only for a turn with no usable words; a turn with words gets the pending question again instead. */
  sayAgain: ['Sorry, could you say that again?'],
  areYouAPerson: [
    "I'm an AI assistant contacting you on Yoshua's behalf, with Yoshua's permission, and this conversation is transcribed.",
    "I'm an AI assistant, reaching out with Yoshua's permission, and this conversation is transcribed.",
  ],
} as const;

/** The first three words, so "Okay, so just to confirm, that's Wednesday" and "...that's Friday" count as the same wording. */
const opener = (s: string) => s.toLowerCase().split(/\s+/).slice(0, 3).join(' ');

/**
 * Picks a variant by turn (PacePay lines said so far, after the greeting), skipping any already said
 * in this negotiation, then any whose opening words were already used; only when every variant is
 * used does a wording come back.
 */
function vary(n: Negotiation, options: readonly string[]): string {
  return varyLine(n, options);
}

function varyLine(n: Negotiation, options: readonly string[]): string {
  const said = (n.transcript ?? []).filter((l) => l.speaker === 'pacepay').map((l) => l.text);
  const turn = Math.max(0, said.length - 1);
  const order = options.map((_, i) => options[(turn + i) % options.length]!);
  const openers = new Set(said.flatMap((s) => s.split(/(?<=[.?!])\s+/)).map(opener));
  return (
    order.find((o) => !said.some((s) => s.includes(o)) && !openers.has(opener(o))) ??
    order.find((o) => !said.some((s) => s.includes(o))) ??
    order.find((o) => o !== said[said.length - 1]) ??
    order[0]!
  );
}

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function ordinal(d: number): string {
  const s = d % 100 >= 11 && d % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][d % 10] ?? 'th');
  return `${d}${s}`;
}

/** "Friday, November 13th": first mentions, the model's context, and the terms Yoshua approved. */
function speakDate(day: Day, day0Date: string): string {
  const [, mm, dd] = dayToISODate(day, day0Date).split('-').map(Number) as [number, number, number];
  return `${formatWeekdayLong(day, day0Date)}, ${MONTHS_LONG[mm - 1] ?? formatShortDate(day, day0Date)} ${ordinal(dd)}`;
}

/** "Friday the 13th" when the day is in today's month, else "Tuesday, December 1st": how the day is said mid-call. */
function sayDay(ctx: ToolContext, day: Day): string {
  const d0 = day0(ctx);
  const [, mm, dd] = dayToISODate(day, d0).split('-').map(Number) as [number, number, number];
  const [, tm] = dayToISODate(ctx.clock.today(), d0).split('-').map(Number) as [number, number];
  return mm === tm ? `${formatWeekdayLong(day, d0)} the ${ordinal(dd)}` : speakDate(day, d0);
}

const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS_WORDS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 35 -> "thirty-five", 120 -> "one hundred twenty", 1500 -> "one thousand five hundred". */
function numberWords(n: number): string {
  if (n < 20) return SMALL[n]!;
  if (n < 100) return `${TENS_WORDS[Math.floor(n / 10)]}${n % 10 ? `-${SMALL[n % 10]}` : ''}`;
  if (n < 1000) return `${SMALL[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ''}`;
  if (n < 1_000_000) return `${numberWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberWords(n % 1000)}` : ''}`;
  return String(n);
}

/** "with no fee", "with a twenty-dollar fee", "with an eighty-dollar fee", "with a fee of twelve dollars and fifty cents". */
function feeWords(fee: Cents): string {
  if (fee === 0) return 'with no fee';
  const dollars = Math.floor(fee / 100);
  const cents = fee % 100;
  if (cents === 0) {
    const w = numberWords(dollars);
    return `with ${/^(eight|eleven)/.test(w) ? 'an' : 'a'} ${w}-dollar fee`;
  }
  return `with a fee of ${dollars ? `${numberWords(dollars)} dollar${dollars === 1 ? '' : 's'} and ` : ''}${numberWords(cents)} cent${cents === 1 ? '' : 's'}`;
}

/** The opening ask from the CallPlan: the target day with no fee. Said at the end of the greeting and whenever the lender asks what PacePay wants. */
export function openingAsk(ctx: ToolContext, n: Negotiation): string {
  return `${n.channel === 'text' ? "I'm reaching out" : "I'm calling"} to ask if this month's payment can move to ${speakDate(n.callPlan.targetDay, day0(ctx))}, with no fee.`;
}

/** The opening ask said again later in the call, in other words. */
function openingAskAgain(ctx: ToolContext, n: Negotiation): string[] {
  const d = sayDay(ctx, n.callPlan.targetDay);
  return [
    openingAsk(ctx, n),
    `We're hoping to move this month's payment to ${d}, with no fee.`,
    `I'm asking whether this month's payment could move to ${d}, with no fee.`,
  ];
}

/** The first thing PacePay says, on a call (the voice brief's greeting) or in the lender console. Ends with the ask. */
export function greetingLine(ctx: ToolContext, n: Negotiation, channel: 'voice' | 'text' = n.channel === 'text' ? 'text' : 'voice'): string {
  const person = personName(ctx);
  const how = channel === 'voice' ? 'calling' : 'contacting you';
  const what = channel === 'voice' ? 'call' : 'conversation';
  return (
    `Hi, I'm PacePay, an AI assistant ${how} on behalf of ${person}, with ${person}'s permission, about the ${accountReference(ctx, n)}. ` +
    `This ${what} is transcribed. ${openingAsk(ctx, n)}`
  );
}

/** The read-back in plain words, for the model's context ("Friday, November 13th, with a twenty-dollar fee"). */
function readBackLine(o: { newDay: Day; fee: Cents }, day0Date: string): string {
  return `So that's ${speakDate(o.newDay, day0Date)}, ${feeWords(o.fee)}?`;
}

/** The read-back as said: "Okay, so just to confirm, that's Friday the 13th with a twenty-dollar fee?" */
function readBackVariants(ctx: ToolContext, o: { newDay: Day; fee: Cents }): string[] {
  const d = sayDay(ctx, o.newDay);
  const f = feeWords(o.fee);
  return [
    `Okay, so just to confirm, that's ${d} ${f}?`,
    `Got it. So that's ${d} ${f}, right?`,
    `Just so I have it right, ${d} ${f}?`,
    `Alright, ${d} ${f}. Is that correct?`,
  ];
}

/** A counter for a day with no fee: "Hmm, would Friday the 13th work instead, with no fee?" */
function askDayVariants(ctx: ToolContext, day: Day): string[] {
  const d = sayDay(ctx, day);
  return [
    `Hmm, would ${d} work instead, with no fee?`,
    `Could we do ${d} instead, with no fee?`,
    `What about ${d}, with no fee?`,
    `Is there any chance ${d} would work, with no fee?`,
  ];
}

/** A reference number said back: spaced out on a call ("A 7 7 3 2") so it's read character by character. */
function sayReference(n: Negotiation, ref: string): string {
  return n.channel === 'text' ? ref : ref.replace(/-/g, '').split('').join(' ');
}

// ---------------------------------------------------------------------------
// The demo calendar: day phrases -> Day
// ---------------------------------------------------------------------------

const WEEKDAY_WORDS: [RegExp, Weekday][] = [
  [/\bmon(day)?\b/, 'Mon'],
  [/\btue(s|sday)?\b/, 'Tue'],
  [/\bwed(nesday)?\b/, 'Wed'],
  [/\bthu(r|rs|rsday)?\b/, 'Thu'],
  [/\bfri(day)?\b/, 'Fri'],
  [/\bsat(urday)?\b/, 'Sat'],
  [/\bsun(day)?\b/, 'Sun'],
];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';

/**
 * Converts a day phrase as the lender said it into a demo Day, or null when it doesn't name one
 * day ("early next week"). Weekdays mean the next one after today; "the 13th" means the next
 * 13th on or after today.
 */
export function parseDayPhrase(phrase: string, today: Day, day0Date: string, weekdaysAfter: Day = today): Day | null {
  const p = phrase.toLowerCase().replace(/[,]/g, ' ');
  if (/\btoday\b/.test(p)) return today;
  if (/\btomorrow\b/.test(p)) return today + 1;

  // Explicit dates: "Nov 13", "November 13th", "13th of November", "11/13", "the 13th".
  const todayIso = dayToISODate(today, day0Date);
  const [ty, tm] = todayIso.split('-').map(Number) as [number, number];
  const fromDate = (month: number | null, date: number): Day | null => {
    if (date < 1 || date > 31) return null;
    const build = (y: number, m: number) => isoDateToDay(`${y}-${String(m).padStart(2, '0')}-${String(date).padStart(2, '0')}`, day0Date);
    if (month !== null) {
      let d = build(ty, month);
      if (d < today - 31) d = build(ty + 1, month);
      return d;
    }
    let d = build(ty, tm);
    if (d < today) d = tm === 12 ? build(ty + 1, 1) : build(ty, tm + 1);
    return d;
  };
  const monthIdx = (m: string) => MONTHS.indexOf(m.slice(0, 3)) + 1;
  let m = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(p);
  if (m) return fromDate(monthIdx(m[1]!), Number(m[2]));
  m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`).exec(p);
  if (m) return fromDate(monthIdx(m[2]!), Number(m[1]));
  m = /\b(\d{1,2})\/(\d{1,2})\b/.exec(p);
  if (m) return fromDate(Number(m[1]), Number(m[2]));
  m = /\b(\d{1,2})(?:st|nd|rd|th)\b/.exec(p);
  if (m) return fromDate(null, Number(m[1]));

  // Weekdays: the next one after today ("next week" pushes it into the following Mon-Sun week).
  const hit = WEEKDAY_WORDS.find(([re]) => re.test(p));
  if (hit) {
    const want = hit[1];
    const nextWeek = /\bnext week\b|\bweek after\b/.test(p);
    const weekIndex = (d: Day) => Math.floor((d + monOffset(day0Date)) / 7);
    const from = Math.max(today, weekdaysAfter);
    for (let d = from + 1; d <= from + 21; d += 1) {
      if (weekdayOf(d, day0Date) !== want) continue;
      if (nextWeek && weekIndex(d) <= weekIndex(from)) continue;
      return d;
    }
    return null;
  }
  return null;
}

/**
 * The payment's current due day (on or after today): bare weekdays count from it, so "Tuesday" on a
 * payment already moved to Friday the 13th means Tuesday the 17th, not the Tuesday before it.
 */
function dueDay(ctx: ToolContext, n: Negotiation): Day {
  const today = ctx.clock.today();
  const moved = /@(\d+)$/.exec(n.itemId);
  if (moved) return Math.max(today, Number(moved[1]));
  const h = ctx.store.household();
  const item = h.scheduled.find((s) => s.id === n.itemId);
  const next = item ? ctx.engine.postingDays(h, item, today + 62).find((d) => d >= today) : undefined;
  return Math.max(today, next ?? today);
}

/**
 * parseDayPhrase for this negotiation: dates as said, bare weekdays after the payment's due day.
 * Today or earlier is never a day to move the payment to ("the system's slow today"), so it's null.
 */
function parseDay(ctx: ToolContext, n: Negotiation, phrase: string): Day | null {
  const d = parseDayPhrase(phrase, ctx.clock.today(), day0(ctx), dueDay(ctx, n));
  return d !== null && d > ctx.clock.today() ? d : null;
}

/** Days from the Monday that starts day 0's week to day 0 (so weeks run Mon-Sun). */
function monOffset(day0Date: string): number {
  const order: Weekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return order.indexOf(weekdayOf(0, day0Date));
}

const REF_UNITS: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
const REF_TEENS: Record<string, string> = { ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19' };
const REF_TENS: Record<string, string> = { twenty: '2', thirty: '3', forty: '4', fifty: '5', sixty: '6', seventy: '7', eighty: '8', ninety: '9' };
const NATO: Record<string, string> = {
  alpha: 'A', alfa: 'A', bravo: 'B', charlie: 'C', delta: 'D', echo: 'E', foxtrot: 'F', golf: 'G', hotel: 'H', india: 'I', juliet: 'J', juliett: 'J',
  kilo: 'K', lima: 'L', mike: 'M', oscar: 'O', papa: 'P', quebec: 'Q', romeo: 'R', sierra: 'S', tango: 'T', uniform: 'U', victor: 'V',
  whiskey: 'W', whisky: 'W', xray: 'X', yankee: 'Y', zulu: 'Z',
};
/** Words that introduce a reference ("your reference number is ..."); the run after one wins. */
const REF_WORDS = new Set(['reference', 'ref', 'confirmation', 'case', 'ticket', 'tracking', 'number', 'code']);

/**
 * A reference number in what the lender said, however it was spoken or transcribed: "A1B2C3",
 * "A 7 7 3 2", "A as in apple, seven seven three two", "reference A seven seven three two",
 * "alpha seven seven three two", "R dash 5 5 8 2 1", "double seven", "it's A7732", "R-55821".
 * Never a date ("the 13th"), an amount ("$20") or one of `exclude` (the account's own "4417").
 */
export function extractReference(text: string, exclude: readonly string[] = []): string | null {
  const t = text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\b([A-Za-z])\s+(?:as in|like in|as an?)\s+[A-Za-z]+\b/g, '$1')
    .replace(/(\p{L})-(\p{L})/gu, '$1 $2')
    .replace(/\b(double|triple)\s+(\w+)/gi, (_, k: string, w: string) => Array(k.toLowerCase() === 'double' ? 2 : 3).fill(w).join(' '));
  type Tok = { s: string; kind: 'digit' | 'alnum' | 'letter' | 'dash' | 'oh' | 'word' | 'key'; stop: boolean; tight: boolean };
  const toks: Tok[] = [];
  const raw = t.split(/\s+/).filter(Boolean);
  for (let i = 0; i < raw.length; i += 1) {
    const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(raw[i]!)!;
    const pre = m[1]!;
    let core = m[2]!;
    let post = m[3]!;
    const lw = core.toLowerCase();
    let kind: Tok['kind'] = 'word';
    if (pre.includes('$') || /^\d{1,2}(st|nd|rd|th)$/i.test(core)) kind = 'word';
    else if (REF_UNITS[lw] !== undefined) (core = REF_UNITS[lw]!), (kind = 'digit');
    else if (REF_TEENS[lw] !== undefined) (core = REF_TEENS[lw]!), (kind = 'digit');
    else if (REF_TENS[lw] !== undefined) {
      // "seventy seven" -> 77, "seventy" -> 70.
      const next = raw[i + 1] ? /^[^\p{L}\p{N}]*([\p{L}]+)/u.exec(raw[i + 1]!)?.[1]?.toLowerCase() : undefined;
      if (post === '' && next && REF_UNITS[next] && next !== 'zero') {
        core = REF_TENS[lw]! + REF_UNITS[next]!;
        post = /[^\p{L}\p{N}]*$/u.exec(raw[i + 1]!)![0];
        i += 1;
      } else core = `${REF_TENS[lw]!}0`;
      kind = 'digit';
    } else if (NATO[lw] !== undefined) (core = NATO[lw]!), (kind = 'letter');
    else if (lw === 'dash' || lw === 'hyphen') (core = '-'), (kind = 'dash');
    else if (lw === 'oh' || lw === 'o') kind = 'oh';
    else if (/^\d+$/.test(core)) kind = 'digit';
    else if (/^[a-z]$/i.test(core)) kind = 'letter';
    else if (/^[a-z0-9][a-z0-9-]*$/i.test(core) && /\d/.test(core)) kind = 'alnum';
    else if (REF_WORDS.has(lw)) kind = 'key';
    // "one... one... nine... four": a reference read slowly; an ellipsis doesn't end the run.
    toks.push({ s: core, kind, stop: /[!?]/.test(post) || (/\./.test(post) && !/\.\.|\u2026/.test(post)), tight: post === '' || post === '-' });
  }
  // "oh" is a zero only right next to other digits ("seven oh two"), not "Oh, okay".
  toks.forEach((k, i) => {
    if (k.kind !== 'oh') return;
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if ((prev && prev.kind === 'digit' && prev.tight) || (next && next.kind === 'digit' && k.tight)) (k.s = '0'), (k.kind = 'digit');
    else k.kind = 'word';
  });
  const refish = (k: Tok) => k.kind === 'digit' || k.kind === 'alnum' || k.kind === 'letter' || k.kind === 'dash';
  const runs: { start: number; text: string }[] = [];
  for (let i = 0; i < toks.length; ) {
    if (!refish(toks[i]!)) {
      i += 1;
      continue;
    }
    const start = i;
    const parts: Tok[] = [];
    while (i < toks.length && refish(toks[i]!)) {
      parts.push(toks[i]!);
      i += 1;
      if (parts[parts.length - 1]!.stop) break;
    }
    // A lowercase "a" or "i" is an article or a pronoun unless digits follow it ("a 7 7 3 2").
    while (parts.length && parts[0]!.kind === 'letter' && /^[ai]$/.test(parts[0]!.s) && parts[1]?.kind !== 'digit' && parts[1]?.kind !== 'alnum') parts.shift();
    const text = parts
      .map((p) => p.s)
      .join('')
      .replace(/^-+|-+$/g, '')
      .toUpperCase();
    const alnum = text.replace(/-/g, '');
    if (!/\d/.test(alnum) || alnum.length < 4) continue;
    if (exclude.includes(alnum)) continue;
    runs.push({ start, text });
  }
  if (!runs.length) return null;
  const keyAt = toks.findIndex((k) => k.kind === 'key');
  return (keyAt >= 0 ? runs.find((r) => r.start > keyAt) : undefined)?.text ?? runs[0]!.text;
}

// ---------------------------------------------------------------------------
// Per-negotiation memory (what PacePay last asked for, which counters were used)
// ---------------------------------------------------------------------------

interface Memory {
  /**
   * The terms PacePay last asked for (the opening ask, a waiver or a day). `stated`: PacePay's own
   * question said the day and the fee ("Could we do Friday the 13th instead, with no fee?"), so a
   * clear yes accepts them without another read-back. The opening ask is not `stated`: a bare
   * "yeah" after the greeting is often just "I'm listening", so it gets a read-back first.
   */
  lastAsk: { newDay: Day; fee: Cents; stated: boolean } | null;
  waiverAsked: Set<Day>;
  /** Days PacePay already asked for at no fee (a counter), so the same counter is never asked twice. */
  askedDays: Set<Day>;
  /** The lender said "there'd be a fee" for this day without an amount; PacePay asked how much. */
  feeDay: Day | null;
  /** A reference the lender gave before PacePay asked for one. */
  earlyRef: string | null;
  /** Model reads that failed or timed out in a row. */
  modelMisses: number;
  /** "Sure, I'll wait" lines said while the lender looks up the reference. */
  refWaits: number;
  /** Times PacePay asked again for the reference after the first ask. */
  refAsks: number;
  /** Days the lender explicitly turned down at no fee ("No" to an ask for that day, "we can't do Friday"). Counters skip them. */
  refusedDays: Set<Day>;
  lowerFeeAsked: boolean;
  openQuestionAsked: boolean;
  counters: number;
  pushbacks: number;
  /** The last ask PacePay made (a counter, a waiver, "what day"), in all its wordings; said again (in other words) when the lender asks what PacePay wants. Null means the opening ask. */
  askLines: readonly string[] | null;
  /** PacePay already asked the lender to repeat a garbled line (asked once, then silence until a real turn). */
  saidSayAgain: boolean;
  /** Hedged answers ("yeah, something like that") to the pending read-back; after one, only a clear yes confirms. */
  hedges: number;
  /** The lender changed or conditioned terms PacePay is holding them to (see Dispute). */
  dispute: Dispute | null;
  /** The terms Yoshua last approved (the deal PacePay may confirm), once he says yes. */
  approved: Terms | null;
  /** The terms of a deal approval that was withdrawn or voided by a change: the next approval text says what changed. */
  changedFrom: { terms: Terms; afterApproval: boolean } | null;
  /** The outstanding deal approval asks Yoshua about terms the lender changed after he approved others. */
  reapproval: boolean;
  /** Why the call ended without a deal after the lender changed terms (Yoshua's honest text). */
  note: CallNote | null;
}

type Terms = { newDay: Day; fee: Cents };

/**
 * The lender changed terms PacePay is holding them to, or added a condition:
 * - phase 'approved': after Yoshua approved (outcome cleared until they honor the approved terms);
 * - phase 'hold': while Yoshua's answer is pending (his question stays open until they insist);
 * - phase 'readback': a condition attached to a read-back or a counter before anything was checked.
 */
interface Dispute {
  phase: 'approved' | 'hold' | 'readback';
  kind: TermChange['kind'] | 'unclear';
  /** The terms PacePay asks the lender to honor. */
  basis: Terms;
  /** The lender's new terms, when they named them. */
  proposed?: Terms;
  /** Times PacePay asked the lender to honor the basis. */
  asks: number;
  /** PacePay asked for the total fee ("plus a processing fee" with no amount). */
  awaitFee?: boolean;
  /** PacePay asked "what would be different?" after a bare no. */
  askedWhat?: boolean;
}

/** What Yoshua is told when a call ends without a deal because the lender changed terms. */
export interface CallNote {
  kind: 'terms' | 'extra_fee' | 'condition' | 'walkback';
  approved: Terms;
  proposed?: Terms;
  approvedByYou: boolean;
  youDeclined?: boolean;
}

const memory = new Map<string, Memory>();
const outcomes = new Map<string, VoiceApprovalResponse>();
const locks = new Map<string, Promise<unknown>>();
const MAX_COUNTERS = 4;

function mem(n: Negotiation): Memory {
  let m = memory.get(n.id);
  if (!m) {
    m = {
      lastAsk: { newDay: n.callPlan.targetDay, fee: 0, stated: false },
      waiverAsked: new Set(),
      askedDays: new Set(),
      feeDay: null,
      earlyRef: null,
      modelMisses: 0,
      refWaits: 0,
      refAsks: 0,
      refusedDays: new Set(),
      lowerFeeAsked: false,
      openQuestionAsked: false,
      counters: 0,
      pushbacks: 0,
      askLines: null,
      saidSayAgain: false,
      hedges: 0,
      dispute: null,
      approved: null,
      changedFrom: null,
      reapproval: false,
      note: null,
    };
    memory.set(n.id, m);
  }
  return m;
}

/** One decide/approvalOutcome at a time per negotiation (the voice worker can overlap calls). */
function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(
    id,
    run.catch(() => undefined),
  );
  return run;
}

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

function load(ctx: ToolContext, id: string): Negotiation {
  return ctx.store.mustGet('negotiations', id);
}

function save(ctx: ToolContext, id: string, patch: Partial<Negotiation>): Negotiation {
  const next = ctx.store.patch('negotiations', id, patch);
  ctx.bus.publish({ event: 'negotiation', data: next });
  return next;
}

function line(ctx: ToolContext, speaker: TranscriptLine['speaker'], text: string): TranscriptLine {
  return { at: ctx.clock.now(), speaker, text };
}

function appendLines(ctx: ToolContext, id: string, lines: TranscriptLine[], patch: Partial<Negotiation> = {}): Negotiation {
  const n = load(ctx, id);
  return save(ctx, id, { ...patch, transcript: [...(n.transcript ?? []), ...lines] });
}

function scopeOf(n: Negotiation): ToolScope {
  return { caseId: n.caseId, caller: 'negotiator', model: 'code' };
}

function day0(ctx: ToolContext): string {
  return ctx.store.household().day0Date;
}

function personName(ctx: ToolContext): string {
  return ctx.store.household().person.name;
}

function counterpartyName(ctx: ToolContext, n: Negotiation): string {
  return ctx.store.household().counterparties.find((c) => c.id === n.counterpartyId)?.name ?? 'the lender';
}

/** "auto loan ending 4417": the only account detail said to a lender (the voice brief uses it too). */
export function accountReference(ctx: ToolContext, n: Negotiation): string {
  const h = ctx.store.household();
  const item = h.scheduled.find((s) => s.id === n.itemId);
  const cp = h.counterparties.find((c) => c.id === n.counterpartyId);
  const kindFor: Record<string, string> = { auto_lender: 'auto_loan', mortgage_servicer: 'mortgage', card_issuer: 'credit_card' };
  const account =
    (item?.counterAccountId ? h.accounts.find((a) => a.id === item.counterAccountId) : undefined) ??
    (cp ? h.accounts.find((a) => a.kind === kindFor[cp.kind]) : undefined);
  if (!account) return 'account';
  return `${account.name.toLowerCase()}${account.reference ? ` ${account.reference}` : ''}`;
}

function emitLine(ctx: ToolContext, n: Negotiation, speaker: 'pacepay' | 'counterparty', text: string): void {
  // Voice calls get their call.transcript rows from the worker's /events posts.
  if (n.channel !== 'text') return;
  ctx.bus.emit({
    type: 'call.transcript',
    model: speaker === 'pacepay' ? 'code' : undefined,
    caseId: n.caseId,
    title: `${speaker === 'pacepay' ? 'PacePay' : 'Lender'}: "${text}"`,
    detail: { negotiationId: n.id, speaker, text },
  });
}

function setCallStatus(ctx: ToolContext, n: Negotiation, patch: { status?: 'active' | 'holding_for_approval'; outcome?: Negotiation['outcome']; referenceNumber?: string }): void {
  if (!n.callId) return;
  const call = ctx.store.getItem('calls', n.callId);
  if (!call) return;
  const next: typeof patch = { ...patch };
  if (next.status && !['active', 'holding_for_approval'].includes(call.status)) delete next.status;
  const updated = ctx.store.patch('calls', call.id, next);
  ctx.bus.publish({ event: 'call', data: updated });
}

/** Closes the negotiation, records the outcome and hands CALL_ENDED to the agent. */
function close(ctx: ToolContext, id: string, lines: string | readonly string[], outcome: NonNullable<Negotiation['outcome']>, extra: Partial<Negotiation> = {}): DecideResult {
  const say = typeof lines === 'string' ? lines : vary(load(ctx, id), lines);
  const n = appendLines(ctx, id, [line(ctx, 'pacepay', say)], { state: 'closed', outcome, pendingOfferId: undefined, ...extra });
  emitLine(ctx, n, 'pacepay', say);
  setCallStatus(ctx, n, { outcome, referenceNumber: n.referenceNumber });
  ctx.bus.emit({
    type: 'call.ended',
    model: 'code',
    caseId: n.caseId,
    title: `Negotiation ended: ${outcome.replace(/_/g, ' ')}${n.referenceNumber ? ` (ref ${n.referenceNumber})` : ''}`,
    detail: { negotiationId: id, outcome, referenceNumber: n.referenceNumber },
  });
  const call = n.callId ? ctx.store.getItem('calls', n.callId) : undefined;
  if (n.channel === 'voice' && call && ['ringing', 'active', 'holding_for_approval'].includes(call.status)) {
    // On a live call the case moves on (summary, Done text, forecast) only once the call has really
    // ended: the voice worker's 'ended' event calls callEnded(). A lender who objects during the
    // goodbye can still void the deal (lateLenderLine). The timer is a backstop if 'ended' never comes.
    const t = setTimeout(() => sendCallEnded(ctx, id), CALL_END_BACKSTOP_MS);
    t.unref?.();
    endTimers.set(id, t);
  } else {
    ctx.enqueue({ id: newId('evt'), at: ctx.clock.now(), type: 'CALL_ENDED', callId: n.callId ?? '', negotiationId: id });
  }
  return { say, next: 'end_call', state: 'closed' };
}

/** The goodbye plays out (up to ~16 s) and the worker hangs up; CALL_ENDED waits for that, at most this long. */
const CALL_END_BACKSTOP_MS = 25_000;
const endTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Enqueues the CALL_ENDED that close() held for a live call (once). */
function sendCallEnded(ctx: ToolContext, id: string): boolean {
  const t = endTimers.get(id);
  if (!t) return false;
  clearTimeout(t);
  endTimers.delete(id);
  const n = load(ctx, id);
  ctx.enqueue({ id: newId('evt'), at: ctx.clock.now(), type: 'CALL_ENDED', callId: n.callId ?? '', negotiationId: id });
  return true;
}

/** PacePay says a line and keeps listening. */
function reply(ctx: ToolContext, id: string, lines: string | readonly string[], patch: Partial<Negotiation> = {}, next: DecideResult['next'] = 'listen'): DecideResult {
  const cur = load(ctx, id);
  let say = typeof lines === 'string' ? lines : vary(cur, lines);
  // Never the same line twice in a row.
  const last = [...(cur.transcript ?? [])].reverse().find((l) => l.speaker === 'pacepay')?.text;
  if (say && last && say === last) say = `Just to repeat: ${say}`;
  const n = appendLines(ctx, id, [line(ctx, 'pacepay', say)], patch);
  emitLine(ctx, n, 'pacepay', say);
  return { say, next, state: n.state };
}

// ---------------------------------------------------------------------------
// Reading the lender's words in code. Most turns (yes, no, repeats, offers with a day and/or a fee,
// holds, questions about the request) never reach a model, so decide answers in milliseconds. The
// model only sees lines code can't read, under a short timeout with a code fallback.
// ---------------------------------------------------------------------------

const UNIT_W: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEEN_W: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TEN_W: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORD_W: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
  thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
};
const MONTH_WORD = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)$/;
const has = (map: Record<string, number>, w: string): boolean => Object.prototype.hasOwnProperty.call(map, w);

/**
 * The lender's words, lowercase, with spoken numbers as digits: "thirty-five dollar fee" -> "35
 * dollar fee", "Friday the thirteenth" -> "friday the 13th", "a hundred bucks" -> "100 bucks".
 * Ordinal words become dates only after "the" or a month, so "one second" stays a second.
 * "can't" -> "cant"; other apostrophes become spaces ("Friday's fine" -> "friday s fine").
 */
export function digitize(text: string): string {
  const toks = text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/n't\b/g, 'nt')
    .replace(/'/g, ' ')
    .replace(/([\p{L}\p{N}])-(\p{L})/gu, '$1 $2')
    .split(/\s+/)
    .filter(Boolean);
  const part = (t: string | undefined) => {
    const m = /^([^\p{L}\p{N}]*)([\p{L}\p{N}]*)(.*)$/u.exec(t ?? '')!;
    return { pre: m[1]!, w: m[2]!, post: m[3]! };
  };
  /** The word after token k, when nothing (a comma, a period) separates them. */
  const after = (k: number) => (k + 1 < toks.length && part(toks[k]).post === '' && part(toks[k + 1]).pre === '' ? part(toks[k + 1]).w : '');
  const out: string[] = [];
  for (let i = 0; i < toks.length; i += 1) {
    const { pre, w } = part(toks[i]);
    let val: number | null = null;
    let ord = false;
    let j = i;
    if (has(TEN_W, w)) {
      val = TEN_W[w]!;
      const nx = after(j);
      if (has(UNIT_W, nx) && UNIT_W[nx]! > 0) (val += UNIT_W[nx]!), (j += 1);
      else if (has(ORD_W, nx) && ORD_W[nx]! < 10) (val += ORD_W[nx]!), (ord = true), (j += 1);
    } else if (has(TEEN_W, w) || has(UNIT_W, w) || (w === 'a' && after(i) === 'hundred')) {
      val = w === 'a' ? 1 : (TEEN_W[w] ?? UNIT_W[w])!;
      if (after(j) === 'hundred') {
        val *= 100;
        j += 1;
        if (after(j) === 'and') j += 1;
        const nx = after(j);
        if (has(TEN_W, nx)) {
          val += TEN_W[nx]!;
          j += 1;
          const nx2 = after(j);
          if (has(UNIT_W, nx2) && UNIT_W[nx2]! > 0) (val += UNIT_W[nx2]!), (j += 1);
        } else if (has(TEEN_W, nx) || (has(UNIT_W, nx) && UNIT_W[nx]! > 0)) (val += (TEEN_W[nx] ?? UNIT_W[nx])!), (j += 1);
      } else if (w === 'a') val = null;
    } else if (has(ORD_W, w)) {
      const prev = out.length ? part(out[out.length - 1]).w : '';
      if (prev === 'the' || MONTH_WORD.test(prev) || after(i) === 'of') (val = ORD_W[w]!), (ord = true);
    }
    if (val === null) {
      out.push(toks[i]!);
      continue;
    }
    out.push(`${pre}${ord ? ordinal(val) : val}${part(toks[j]).post}`);
    i = j;
  }
  return out.join(' ');
}

/** Clauses of a digitized line: "wednesday s out, but friday works" -> ["wednesday s out", "friday works"]. */
function clausesOf(d: string): string[] {
  return d
    .split(/[;!?]+|\.(?=\s|$)|,(?!\d{3})|\bbut\b|\bhowever\b|\balthough\b|\bthough\b/)
    .map((c) => c.trim())
    .filter(Boolean);
}

const N = '(\\d{1,4}(?:\\.\\d{1,2})?)';
const NOT_A_DATE = '(?!\\s*(?:st|nd|rd|th|days?|weeks?|months?|minutes?|mins?|seconds?|secs?|hours?|percent)\\b)';
const FEE_PATTERNS = [
  // "20 fee", "20 dollar charge", "a $20 fee"
  new RegExp(`\\b${N}\\s*(?:dollars?|bucks)?\\s*(?:fee|charge|cost)\\b`),
  // "fee would be 20", "fee of 20", "the charge is 20", "fee s 20"
  new RegExp(`\\b(?:fees?|charge|cost)\\s+(?:(?:would|will|is|s|of|at|be|comes to|runs|around|about|just|only|it s|its|would be|will be|is just|is only|of about|of around|you|him|them|yoshua|d|ll)\\s+)*(?:a\\s+)?\\$?${N}\\b${NOT_A_DATE}`),
  // "doable for 20", "for just $20"
  new RegExp(`\\bfor\\s+(?:a\\s+|just\\s+|only\\s+)?\\$?${N}\\b${NOT_A_DATE}`),
];
/** A bare number when a fee is already the topic: "I can do twenty", "make it 15", "best is 20". */
const BARE_FEE = new RegExp(
  `\\b(?:do|be|make it|go|offer|it s|its|is|s|at|charge|cost|only|just|down to|lower it to|bring it down to|reduce it to|drop it to|knock it down to)\\s+(?:a\\s+|just\\s+|only\\s+)?\\$?${N}\\b${NOT_A_DATE}`,
);
const ONLY_A_NUMBER = new RegExp(`^(?:(?:um|uh|like|maybe|how about|what about|say|okay|ok|well|so)\\s+)*\\$?${N}(?:\\s+(?:dollars?|bucks))?$`);
/** "No fee", "we can waive it", "we don't charge": a fee of zero (unless negated, below). */
const ZERO_FEE = /\b(no fees?|without (?:a|any|the) fee|no charge|free of charge|for free|waive|waived|waiving|no extra charge|no cost|at no cost|fee free|(?:dont|do not|wont|will not) charge)\b/;
/** "Can't waive it", "not without a fee", "the fee can't be removed". */
const ZERO_NEGATED =
  /\b(cant|cannot|wont|unable to|not able to|couldnt|dont think|no way to|not going to|isnt|is not|not)\b[^.,;]*\b(waive|waived|no fee|without (?:a|any|the) fee|for free|no charge|remove|drop)\b|\bnot without\b|\bwaive\w*\b[^.,;]*\b(isnt|not possible|cant|cannot)\b/;

/**
 * The fee in a digitized line, or null. Amounts with a $, "dollars" or "bucks" are exact; a number
 * next to "fee"/"charge" or after "for" is a fee; a bare number ("I can do twenty") is a fee only
 * when a fee is already the topic (feeTopic).
 */
function feeIn(d: string, feeTopic: boolean): Cents | null {
  const typed = findDollarAmount(d);
  if (typed !== null) return typed;
  for (const re of FEE_PATTERNS) {
    const m = re.exec(d);
    if (m && Number(m[1]) > 0 && Number(m[1]) <= 1000) return dollarsToCents(Number(m[1]));
  }
  if (feeTopic) {
    const bare = BARE_FEE.exec(d) ?? ONLY_A_NUMBER.exec(normalizeReply(d));
    if (bare) {
      const v = Number(bare[1]);
      if (v > 0 && v <= 500) return dollarsToCents(v);
    }
  }
  return null;
}

/** A fee in what the lender said, typed ("$35", "35 dollars") or spoken ("thirty-five dollar fee", "a hundred dollars"). */
export function feeAmount(text: string): Cents | null {
  return feeIn(digitize(text), false);
}

/** Three or more numbers in a row ("1 1 9 4"): digits read out, a reference. */
const DIGIT_RUN = /(?:^|\s)\d{1,2}(?:\s+\d{1,2}){2,}(?=\s|$)/;
const NOT_A_NO = /\b(no (fees?|charge|cost|extra charge|problem|worries)|not a problem|without (a|any) fee)\b/g;
/** A clause that turns its day down: "we can't do Friday", "Friday won't work", "not Friday", "Wednesday's out". */
const REFUSES_DAY =
  /\b(cant|cannot|unable to|not able to|couldnt|no can do|not gonna|not going to)\b|\b(wont|doesnt|does not|isnt|is not|not|aint)\s+(work|working|possible|available|doable|an option|going to work|gonna work|happen|good)\b|\bnot\s+(on\s+)?(the\s+)?(mon|tue|wed|thu|fri|sat|sun|\d)|\b(is|s)\s+(out|booked|full|no good)\b|\bno good\b/;
/** "The latest I can do is X", "nothing beyond X", "we can only do X": X is on the table. */
const BOUND = /\b(latest|earliest|furthest|farthest|beyond|past|later than|after|up to|until|at most|only|best i can|most i can)\b/;
/** The lender won't move the payment at all. */
const REFUSES_ALL =
  /\b(cant|cannot|wont|unable to|not able to|dont|do not|doesnt|does not|no way|not allowed)\b.*\b(move|moving|change|changing|push|extend|extension|extensions|reschedul\w*|adjust|defer|deferral|delay|due dates?|payment dates?|date changes?)\b|\bpolicy\b|\bnot something we (do|offer)\b/;
const VERIFY =
  /\b(verify|verification|verified|security questions?|account holder|primary (account )?holder|(speak|talk) (to|with) (him|her|them|yoshua|the customer|the borrower|the account|the owner)|on the line|date of birth|social security|ssn|last four|authorization form|third party authori[sz]ation)\b/;
/** Any word that says a day was meant, even one code can't pin down ("early next week"). */
const DAY_WORDS = /\b(next week|this week|end of the week|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tues?|wed|thurs?|fri|today|tomorrow|\d{1,2}(st|nd|rd|th)|january|february|march|april|june|july|august|september|october|november|december)\b/;

const YES_TOKENS = new Set(
  'yes yeah yep yup ya yah yea yeh yess yesh correct right exactly sure absolutely definitely affirmative confirmed confirm perfect great fine okay ok k alright all mhm mmhm mmhmm mhmm mmm mm hmm hm uhhuh uh huh that thats is it its you got sounds good works work for me we i can do sir maam indeed true precisely set agreed so just yup totally'.split(' '),
);
const POSITIVE = /\b(yes|yeah|yep|yup|ya|yah|yea|yeh|yess|yesh|correct|right|exactly|sure|absolutely|definitely|affirmative|confirmed?|perfect|great|fine|okay|ok|k|alright|mhm|mmhm|mmhmm|mhmm|uhhuh|uh huh|mm hmm|hm|indeed|true|precisely|agreed|works?|got it|thats it|all set|can do|we can|i can|totally)\b/;
/** A yes that agrees to terms PacePay just asked for (not just "okay" or "mm-hm"). */
const STRONG_YES = /\b(yes|yeah|yep|yup|ya|yah|yea|yeh|yess|yesh|correct|exactly|sure|absolutely|definitely|affirmative|confirmed?|agreed|works?|fine|we can|i can|can do|thats right|that is right|you got it|sounds good|totally)\b/;
const NO_TOKENS = new Set('no nope nah not quite incorrect wrong thats that is isnt it right sorry negative uh um we i im cant cannot can do afraid unfortunately really actually so'.split(' '));
const NEGATIVE = /\b(no|nope|nah|not|incorrect|wrong|negative|isnt|cant|cannot)\b/;

/** "Yes", "yeah that's right", "mm-hm", "yep, that's it": a confirmation. Null when the line says anything else. */
function yesWords(utterance: string): { strong: boolean } | null {
  if (utterance.includes('?')) return null;
  const plain = normalizeReply(utterance);
  if (/^(no problem|not a problem|no worries|no problem at all)$/.test(plain)) return { strong: true };
  const words = plain.split(' ').filter(Boolean);
  if (!words.length || !words.every((w) => YES_TOKENS.has(w)) || !POSITIVE.test(plain)) return null;
  if (NEGATIVE.test(plain)) return null;
  return { strong: STRONG_YES.test(plain) };
}

/** "No", "nope, that's not right", "we can't do that": a plain no. */
/** "That's the best we can do", "nothing else", "no other days": a no to the current ask. */
const NOTHING_MORE = /\b(best (we|i) can do|all (we|i) can (do|offer)|nothing else|nothing (more|further)|no other (days?|dates?|options?)|(we|i) (have|got) nothing)\b/;

function noWords(utterance: string): boolean {
  if (utterance.includes('?')) return false;
  const plain = normalizeReply(utterance);
  const words = plain.split(' ').filter(Boolean);
  if (words.length > 0 && words.every((w) => NO_TOKENS.has(w)) && NEGATIVE.test(plain)) return true;
  // "Nope, nothing else.", "No, sorry, that's the most we can do."
  if (/^(no|nope|nah|negative)\b/.test(plain) && !/^no (problem|worries|fees?|charge)\b/.test(plain)) return true;
  return NOTHING_MORE.test(plain);
}

type Reading =
  | { kind: 'offer'; days: Day[]; dayWords: boolean; fee: Cents | null; feeNoAmount: boolean; refused: Day[]; summed?: boolean }
  | { kind: 'confirm'; strong: boolean }
  | { kind: 'deny' }
  | { kind: 'refused_days'; days: Day[] }
  | { kind: 'refusal' }
  | { kind: 'verification' }
  | { kind: 'say'; text: string };

/**
 * A fee is already the topic, so a bare number ("I can do twenty", "Twenty.") is a fee, not a date:
 * any day is on the table (the ask, a read-back, an offer), PacePay asked about the fee, or the
 * line says "fee". Dates still read as dates ("the 16th").
 */
function feeTopic(n: Negotiation, m: Memory, pending: Offer | undefined, d: string): boolean {
  return (
    m.feeDay !== null ||
    m.lastAsk !== null ||
    pending !== undefined ||
    n.offers.length > 0 ||
    m.askLines === LINES.waiver ||
    m.askLines === LINES.lowerFee ||
    /\b(fee|fees|charge|cost)\b/.test(d)
  );
}

/** Every day named in a digitized clause, in the order said ("thursday or friday" -> [Thu, Fri]). */
function daysIn(ctx: ToolContext, n: Negotiation, clause: string): Day[] {
  const parts = clause.split(/\bor\b|\band\b|\/(?!\d)/);
  const out: Day[] = [];
  for (const p of parts) {
    const d = parseDay(ctx, n, p);
    if (d !== null && !out.includes(d)) out.push(d);
  }
  if (!out.length) {
    const whole = parseDay(ctx, n, clause);
    if (whole !== null) out.push(whole);
  }
  return out;
}

/**
 * What the lender's line means, read by code, or null when code can't tell (the model reads it).
 * Offers are read clause by clause: a clause that turns a day down records that day as refused, the
 * others give the offered day(s) and fee. "How it works, but there's a $35 fee" (speech-to-text for
 * "Friday works") is an offer of $35 with the day left to context.
 */
function readInCode(ctx: ToolContext, n: Negotiation, m: Memory, utterance: string, pending: Offer | undefined): Reading | null {
  const d = digitize(utterance);
  // "One... one... nine... four": digits read one at a time are a reference, never a bare fee.
  const topic = feeTopic(n, m, pending, d) && !DIGIT_RUN.test(d.replace(/[.,\u2026]+/g, ' '));
  const offered: Day[] = [];
  const fees: { fee: Cents; extra: boolean; total: boolean }[] = [];
  const refused: Day[] = [];
  let fee: Cents | null = null;
  let zero = false;
  let zeroNegated = false;
  let feeWord = false;
  let dayWords = false;
  for (const raw of clausesOf(d)) {
    const clause = raw;
    const plainClause = raw.replace(NOT_A_NO, ' ');
    const days = daysIn(ctx, n, clause);
    const f = feeIn(clause, topic);
    if (f !== null && fee === null) fee = f;
    if (f !== null) fees.push({ fee: f, extra: EXTRA_FEE.test(clause), total: TOTAL.test(clause) });
    if (ZERO_NEGATED.test(clause)) zeroNegated = true;
    else if (ZERO_FEE.test(clause)) zero = true;
    if (/\b(fee|fees|charge|cost)\b/.test(clause)) feeWord = true;
    if (days.length && REFUSES_DAY.test(plainClause) && !BOUND.test(plainClause)) {
      for (const day of days) if (!refused.includes(day)) refused.push(day);
      continue;
    }
    for (const day of days) if (!offered.includes(day)) offered.push(day);
    if (!days.length && DAY_WORDS.test(clause)) dayWords = true;
  }
  if (fee === null && zero && !zeroNegated) fee = 0;
  // "Friday with a $20 fee... also a $10 processing fee on top, so $30 total": the whole fee, not the first one.
  let summed = false;
  if (fees.length > 1 && fees.some((x) => x.extra || x.total)) {
    // The total when one is said; else the base fee plus each distinct extra ("ten dollars on top,
    // ten dollars" is one $10, not two).
    const total = fees.find((x) => x.total);
    const base = fees[0]!.fee;
    const extras = [...new Set(fees.slice(1).filter((x) => x.extra && x.fee !== base).map((x) => x.fee))];
    fee = total ? total.fee : base + extras.reduce((a, x) => a + x, 0);
    summed = true;
  }
  const feeNoAmount = fee === null && feeWord && !zero;
  // "We can't do Friday without a fee": Friday is on the table, with a fee. Ask how much.
  if (fee === null && zeroNegated && !offered.length && refused.length === 1) {
    return { kind: 'offer', days: refused, dayWords: false, fee: null, feeNoAmount: true, refused: [] };
  }

  if (offered.length || fee !== null) return { kind: 'offer', days: offered, dayWords, fee, feeNoAmount, refused, ...(summed ? { summed } : {}) };
  if (refused.length) return { kind: 'refused_days', days: refused };
  // "We can't waive it", "the fee stays": a no to the waiver ask.
  if (zeroNegated) return { kind: 'deny' };
  if (VERIFY.test(d)) return { kind: 'verification' };
  if (REFUSES_ALL.test(d)) return { kind: 'refusal' };
  if (feeNoAmount) return { kind: 'offer', days: [], dayWords, fee: null, feeNoAmount, refused: [] };
  if (dayWords) return { kind: 'offer', days: [], dayWords, fee: null, feeNoAmount: false, refused: [] };
  const yes = yesWords(utterance);
  if (yes) return { kind: 'confirm', strong: yes.strong };
  if (noWords(utterance)) return { kind: 'deny' };
  return null;
}

// ---------------------------------------------------------------------------
// The model: only for lines code can't read
// ---------------------------------------------------------------------------

const KINDS = ['offer', 'confirm', 'deny', 'question', 'verification_request', 'refusal', 'chitchat'] as const;

const ClassifySchema = z.object({
  kind: z.enum(KINDS),
  offer: z
    .object({
      day: z.string().nullish(),
      fee: z.union([z.number(), z.string()]).nullish(),
    })
    .nullish(),
  say: z.string().nullish(),
});
type Classified = z.infer<typeof ClassifySchema>;

function feeDollars(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(v.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** On a call the model gets this long before code falls back (the lender is waiting in silence). */
const VOICE_DECIDE_TIMEOUT_MS = 2_500;

async function classify(ctx: ToolContext, n: Negotiation, utterance: string, waitingFor: string): Promise<Classified> {
  const system = loadPrompt('negotiator', {
    person_name: personName(ctx),
    counterparty_name: counterpartyName(ctx, n),
    'call_plan.goal': `Move ${personName(ctx)}'s payment to a later day`,
    'call_plan.opening_ask': `move this month's payment to ${speakDate(n.callPlan.targetDay, day0(ctx))} with no fee`,
    account_reference: accountReference(ctx, n),
  });
  const transcript = (n.transcript ?? [])
    .slice(-12)
    .map((l) => `${l.speaker === 'pacepay' ? 'PACEPAY' : 'LENDER'}: ${l.text}`)
    .join('\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `Today is ${speakDate(ctx.clock.today(), day0(ctx))}.\nTRANSCRIPT:\n${transcript || '(none)'}\n\nPACEPAY IS WAITING FOR: ${waitingFor}\nLENDER JUST SAID: ${utterance}`,
    },
  ];
  // A call can't wait long: a short cap, then code's fallback. Typed negotiations (console, arena) wait longer.
  const timeoutMs = n.channel === 'voice' ? Math.min(DEFAULT_TIMEOUTS.decide, VOICE_DECIDE_TIMEOUT_MS) : TEXT_DECIDE_TIMEOUT_MS;
  // The client enforces timeoutMs; the race is a backstop so a stuck request can never hold the call.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`decide model took over ${timeoutMs} ms`)), timeoutMs + 150);
  });
  try {
    const r = await Promise.race([
      ctx.models.chat({ role: 'decide', messages, json: ClassifySchema, timeoutMs, caseId: n.caseId, title: `${modelLabel(ctx)} read the lender's words` }),
      late,
    ]);
    return r.json;
  } finally {
    clearTimeout(timer);
  }
}

function modelLabel(ctx: ToolContext): string {
  const role = ctx.models.roleFor('decide');
  return role === 'nemotron-nano' ? 'Nemotron Nano' : role === 'nemotron-super' ? 'Nemotron Super' : role;
}

/** The model's label turned into a Reading. Code still has the last word on days and fees. */
function readModel(ctx: ToolContext, n: Negotiation, m: Memory, utterance: string, c: Classified, pending: Offer | undefined): Reading {
  const coded = readInCode(ctx, n, m, utterance, pending);
  switch (c.kind) {
    case 'offer': {
      const phrase = c.offer?.day?.trim() ?? '';
      const fromPhrase = phrase ? parseDay(ctx, n, phrase) : null;
      const empty: Extract<Reading, { kind: 'offer' }> = { kind: 'offer', days: [], dayWords: false, fee: null, feeNoAmount: false, refused: [] };
      const base = coded?.kind === 'offer' ? coded : empty;
      const days = base.days.length ? base.days : fromPhrase !== null ? [fromPhrase] : [];
      const dollars = feeDollars(c.offer?.fee);
      const fee = base.fee ?? (dollars !== null && dollars >= 0 ? dollarsToCents(dollars) : null);
      return { ...base, days, dayWords: base.dayWords || (phrase !== '' && fromPhrase === null), fee };
    }
    case 'confirm':
      // A yes only the model heard is never strong enough to skip the read-back.
      return { kind: 'confirm', strong: false };
    case 'deny':
      return { kind: 'deny' };
    case 'refusal':
      return { kind: 'refusal' };
    case 'verification_request':
      return { kind: 'verification' };
    default: {
      if (HOLDING.test(normalizeReply(utterance))) return { kind: 'say', text: vary(n, LINES.takeYourTime) };
      // Before any offer is on the table the only thing worth saying is the ask itself.
      if (n.offers.length === 0 && !pending) return { kind: 'say', text: currentAsk(ctx, n, m) };
      const ask = currentAsk(ctx, n, m);
      const answer = safeSay(ctx, n, m, c.say);
      return { kind: 'say', text: answer === ask ? ask : `${answer} ${ask}` };
    }
  }
}

/**
 * Words a model-written line may not contain (SPEC §5.3, §7.3): money, Yoshua's finances, a reason
 * for wanting the change, or anything that sounds like agreeing to terms (only code agrees, and
 * only after Yoshua approves).
 */
const LEAK_WORDS =
  /\b(balance|pay ?checks?|payday|paid|pays|salary|wages?|income|deposits?|limit|floor|afford\w*|overdra\w*|savings|checking|mortgage|cushion|budget|dollars?|bucks|cents|money|cash|funds?|bills?|rent|repairs?|expenses?|emergenc\w*|unexpected|short|tight|hardship|struggl\w*|trouble|behind|late|debt|owe[sd]?|because|due to|since|reasons?|conflicts?|schedul\w*|hundred|thousand|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|agree\w*|accept\w*|approv\w*|deal|go ahead|sounds good|works for|confirm\w*|authori[sz]e[sd]? (?:me|you|the|this|it|that)|promise\w*|can'?t|cannot|won'?t|refuse\w*|decline\w*|waiver)\b/i;

/**
 * Keeps a small-talk answer inside the brief: no money, no reasons, no agreeing or refusing, no
 * account numbers beyond the reference. Anything unsafe is replaced by the current ask.
 */
function safeSay(ctx: ToolContext, n: Negotiation, m: Memory, say: string | null | undefined): string {
  const fallback = currentAsk(ctx, n, m);
  const s = (say ?? '').trim();
  if (!s) return fallback;
  if (/[$%#?]/.test(s)) return fallback;
  if (LEAK_WORDS.test(s)) return fallback;
  // The only digits allowed are the account reference's own ("4417").
  const allowed: string[] = accountReference(ctx, n).match(/\d+/g) ?? [];
  const digits = s.match(/\d+/g) ?? [];
  if (digits.some((d) => !allowed.includes(d))) return fallback;
  return s.split(/(?<=[.?!])\s+/).slice(0, 1).join(' ');
}

/** What PacePay is asking for right now, in words: the pending read-back, the last counter, or the opening ask. */
function currentAsk(ctx: ToolContext, n: Negotiation, m: Memory): string {
  if (m.dispute) return honorAsk(ctx, n, m);
  if (n.state === 'awaiting_approval') return vary(n, LINES.stillHolding);
  const pending = n.pendingOfferId ? n.offers.find((o) => o.id === n.pendingOfferId) : undefined;
  if (pending) {
    // The read-back was already said once: ask it again in other words, not the same read-back.
    const d = sayDay(ctx, pending.newDay);
    const f = feeWords(pending.fee);
    return vary(n, [`Sorry, just to make sure I have it right, is that ${d} ${f}?`, `And just to confirm, that's ${d} ${f}?`, `So can I confirm ${d} ${f}?`]);
  }
  return vary(n, m.askLines ?? openingAskAgain(ctx, n));
}

const ASKS_A_QUESTION = /\?|^\s*(what|why|how|when|where|who|which|is|are|does|do|did|can|could|would|will|tell me|explain)\b/i;
/** Fishing for Yoshua's finances, his reasons, or PacePay's limits. "Why are you calling" is about the request, not a reason. */
const ABOUT_FINANCES =
  /\b(why(?! (are|were|did) you (calling|call|reaching))|reasons?|balance|paid|pay ?checks?|payday|salary|wages?|income|savings|checking account|afford\w*|money|funds|cash|bills?|budget|financ\w*|trouble|struggl\w*|hardship|limit|floor|the most|max(imum)?|how much|willing to pay|bounce|overdra\w*|short on|behind on|other (payments|loans|debts?|accounts?))\b/i;
const ABOUT_BEING_AI = /\b(real person|a person|human|robot|a bot|bot|an ai|ai|automated|machine|recording|recorded)\b/i;
/**
 * Ordinary questions about the request itself ("How can I help?", "Do you not want to move the
 * payment?", "Which payment?", "What date?"): the answer is the ask. Tested on normalizeReply text
 * (lowercase, no punctuation or apostrophes).
 */
const ABOUT_THE_REQUEST =
  /\b(how (can|may|could) (i|we) help|what can (i|we) do|what do you (need|want)|what (did|do|would) you (need|want|like)|what would you like|what are you (asking|calling|looking)|whats (this|it) (about|regarding)|what is (this|it) (about|regarding)|(why|what) (are|were|did) you (calling|call|reaching)|which (payment|account|loan|one|bill)|what (payment|account|loan)|(what|which) (date|day)|when (do|would) you (want|like)|(do|did) you (not )?(want|need) (to|me to|us to) move|you (want|need|would like) (to|me to|us to) move|move (the|which|what|my|your|his|this) payment|(say|repeat) (that|it) again|repeat that|come again|pardon|what was that|sorry what|say again)\b/;
/** "Who is this again?", "Who are you with?", "Where are you calling from?" */
const WHO_IS_THIS = /\b(who (is|s) (this|calling|that)|whos (this|calling)|who are you|who am i (speaking|talking)|who did you say|where are you calling from|what company|who do you (work for|represent)|(your|whats your) name|name on (the|this|that) (account|loan)|whose (account|loan) (is (it|this)|is that)|who is the (account|loan) for)\b/;
/** "What's the account number?", "Can I get the full account number?": only the reference is ever said. */
const ACCOUNT_NUMBER = /\b((full|whole|complete|entire) (account|loan) number|(account|loan) number|which account|what account)\b/;
/** "Are you still there?", "Can you hear me?": PacePay is here, and says where things stand. */
const STILL_THERE = /\b(are you (still )?there|(is )?(anyone|anybody|someone|somebody) (still )?there|you still there|you there|still with me|still on the line|can you hear me|did i lose you|are you on the line)\b/;
const GREETING = /^(hello|hi|hey|hello there|hi there|hey there|hello hello|yes hello|yeah hello|good (morning|afternoon|evening)|hello yes|hello hi|hi hello|thanks|thank you|thank you so much|thanks so much|okay thanks|ok thanks|great thanks)$/;
/** "Hold on, let me pull that up": the lender is working on it. */
const HOLDING =
  /\b(hold on|hang on|one (moment|sec|second|minute)|1 (moment|sec|second|minute)|just a (moment|sec|second|minute)|(give me|gimme) (a|one) (moment|sec|second|minute)|let me (pull|check|look|see|find|bring|get|grab)|bear with me|pulling (it|that|the account) up|checking (on )?(that|now)|looking (into )?(that|it) up|let me just|(talk|speak|check) (to|with) (my|a|the) (supervisor|manager|boss|team lead|lead|team)|(ask|run (it|this|that) by) (my|a|the) (supervisor|manager|boss))\b/;

/** "This is PacePay, an AI assistant calling on behalf of Yoshua...": who's calling, in one line. */
function identityLine(ctx: ToolContext, n: Negotiation): string {
  const person = personName(ctx);
  return `This is PacePay, an AI assistant ${n.channel === 'text' ? 'reaching out' : 'calling'} on behalf of ${person}, with ${person}'s permission, about the ${accountReference(ctx, n)}.`;
}

/**
 * Lender questions code answers without the model: whether PacePay is a person, who's calling,
 * anything about Yoshua's money or why he wants the change, greetings, and what PacePay is asking
 * for. Each answer ends with the current ask, so the call keeps moving.
 */
function presetAnswer(ctx: ToolContext, n: Negotiation, m: Memory, utterance: string): string | null {
  const d = digitize(utterance);
  const plain = normalizeReply(utterance);
  const question = ASKS_A_QUESTION.test(utterance);
  const hasTerms = feeIn(d, false) !== null || parseDay(ctx, n, d) !== null;
  // "Why Friday?", "Can he afford twenty?": never a reason or a number, even when a day or fee is named.
  if (question && ABOUT_FINANCES.test(utterance) && (!hasTerms || /\b(why|afford\w*|how much can|the most|max(imum)?|paid|payday|pay ?check)\b/i.test(utterance))) {
    return `${vary(n, LINES.privateDetails)} ${currentAsk(ctx, n, m)}`;
  }
  if (hasTerms) return null;
  if (ABOUT_BEING_AI.test(utterance) && (question || /\b(robot|bot|ai|automated|machine)\b/i.test(utterance))) return `${vary(n, LINES.areYouAPerson)} ${currentAsk(ctx, n, m)}`;
  if (WHO_IS_THIS.test(plain)) return `${identityLine(ctx, n)} ${currentAsk(ctx, n, m)}`;
  if (ACCOUNT_NUMBER.test(plain) && question && !VERIFY.test(d)) return `${vary(n, [`It's the ${accountReference(ctx, n)}; that's the only detail I'm able to share.`, `I can only share that it's the ${accountReference(ctx, n)}.`])} ${currentAsk(ctx, n, m)}`;
  if (STILL_THERE.test(plain)) return `${vary(n, ["Yes, I'm here.", "Yes, I'm still here.", "I'm here."])} ${currentAsk(ctx, n, m)}`;
  // "Hello?", "Yes?" (go on): the ask again.
  if (GREETING.test(plain) || (/\?/.test(utterance) && /^(yes|yeah|yep|ok|okay|hello|sorry|uh huh|go ahead)$/.test(plain))) return currentAsk(ctx, n, m);
  // "No, we can't move the payment" is a refusal, not a question about the request.
  if (ABOUT_THE_REQUEST.test(plain) && !/\b(cant|cannot|wont|unable|not able)\b/.test(plain)) return currentAsk(ctx, n, m);
  return null;
}

// ---------------------------------------------------------------------------
// Garbage turns (line noise, echo, half-heard fragments)
// ---------------------------------------------------------------------------

/** Short replies that mean something on their own ("Yes.", "Sure.", "Hello?"). */
const SHORT_OK =
  /^(y|yes|yeah|yep|yup|ya|yah|yea|no|n|nope|nah|ok|okay|k|sure|correct|right|done|fine|great|perfect|hello|hi|hey|thanks|thank you|go ahead|hold on|one moment|one sec|sorry|pardon|what|huh|deal|absolutely|alright|all right|of course|got it|sounds good|that works|thats right|thats fine|thats correct|no problem|not really|bye|goodbye|uh huh|uhhuh|mhm|mmhm|mmhmm|mhmm|mm hmm|yes please|no thanks|i can|we can|i cant|we cant|it is|it does|you too|exactly)$/;
/** Words that make a short line a real turn. */
const CONTENT_WORDS =
  /\b(i|im|ill|ive|id|we|were|well|weve|wed|you|your|youre|he|hes|his|him|she|shes|her|they|their|can|could|would|will|cant|wont|dont|do|does|did|is|are|was|not|what|whats|which|when|whens|why|how|hows|who|whos|where|wheres|yes|no|move|moved|moving|payment|pay|fee|fees|waive|waived|charge|day|date|week|month|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|dollars?|bucks|reference|number|account|loan|hold|moment|second|minute|wait|verify|help|sorry|okay|sure|fine|works|thats|deal|done|customer|yoshua|person|ai|calling|call|robot)\b/;

/**
 * Line noise and echo that the speech-to-text turned into words ("까지", "Aha.", "It only this
 * visible."): 'silent' gets no reply, 'repeat' gets "Sorry, could you say that again?". Either way
 * nothing is recorded and no state changes. Null means a real turn.
 */
function garbage(utterance: string): 'silent' | 'repeat' | null {
  const letters = utterance.match(/\p{L}/gu) ?? [];
  if (/\d/.test(utterance)) return null;
  if (letters.length === 0) return 'silent';
  const latin = letters.filter((ch) => /[A-Za-z]/.test(ch)).length;
  if (latin / letters.length < 0.6) return 'silent';
  const plain = normalizeReply(utterance);
  if (SHORT_OK.test(plain) || yesWords(utterance) || noWords(utterance)) return null;
  // "Yeah, something like that": a real (hedged) answer, never noise.
  if (isHedge(utterance) || /\b(yeah|yes|yep|yup|okay|ok|sure|right|fine|nope|nah)\b/.test(plain)) return null;
  // A spoken number ("Twenty.") or a day ("Fri") is a real answer.
  if (/\d/.test(digitize(utterance)) || DAY_WORDS.test(plain)) return null;
  if (ABOUT_BEING_AI.test(utterance) || ABOUT_FINANCES.test(utterance) || ABOUT_THE_REQUEST.test(plain)) return null;
  const words = plain.split(' ').filter(Boolean);
  if (words.length > 5 || CONTENT_WORDS.test(plain)) return null;
  return words.length <= 1 ? 'silent' : 'repeat';
}

// ---------------------------------------------------------------------------
// Counters (code picks them from the CallPlan)
// ---------------------------------------------------------------------------

const FAILURES = (c: OfferCheck) => c.reasons.filter((r) => r !== 'OK' && r !== 'WEEKEND_ROLLS_FORWARD');

/**
 * The next counter for a failing offer, or null when PacePay has nothing left to ask for.
 * 1. Only the fee fails: ask for a waiver on that day (once per day), then for a lower fee (once).
 * 2. Otherwise always the CallPlan's targetDay with no fee, unless the lender explicitly turned that
 *    day down; then the next acceptable day, in acceptableDays order, that wasn't turned down.
 * 3. A lower fee, once.
 */
function nextCounter(ctx: ToolContext, n: Negotiation, m: Memory, offer: Offer | undefined, check: OfferCheck | undefined): { lines: readonly string[]; ask: Memory['lastAsk'] } | null {
  if (m.counters >= MAX_COUNTERS) return null;
  const plan = n.callPlan;
  const failures = check ? FAILURES(check) : [];
  const feeOnly = failures.length > 0 && failures.every((r) => r === 'FEE_OVER_LIMIT');

  if (offer && feeOnly && !m.waiverAsked.has(offer.newDay)) {
    m.waiverAsked.add(offer.newDay);
    return { lines: LINES.waiver, ask: { newDay: offer.newDay, fee: 0, stated: false } };
  }
  // The day works but the fee is too high and they won't waive it: ask them to bring it down first.
  if (offer && feeOnly && offer.fee > 0 && !m.lowerFeeAsked) {
    m.lowerFeeAsked = true;
    return { lines: LINES.lowerFee, ask: null };
  }
  // A day already asked for as a waiver is that day with no fee: asking it again is not a new counter.
  const days = [plan.targetDay, ...plan.acceptableDays].filter((d, i, all) => all.indexOf(d) === i && d > ctx.clock.today());
  const nextDay = days.find((d) => !m.refusedDays.has(d) && !(d === offer?.newDay && m.waiverAsked.has(d)) && !m.askedDays.has(d));
  if (nextDay !== undefined) return { lines: askDayVariants(ctx, nextDay), ask: { newDay: nextDay, fee: 0, stated: true } };

  if (offer && offer.fee > 0 && !m.lowerFeeAsked) {
    m.lowerFeeAsked = true;
    return { lines: LINES.lowerFee, ask: null };
  }
  return null;
}

function lastOfferAndCheck(n: Negotiation): { offer?: Offer; check?: OfferCheck } {
  const checks = n.checks ?? [];
  const check = checks[checks.length - 1];
  const offer = check ? n.offers.find((o) => o.id === check.offerId) : n.offers[n.offers.length - 1];
  return { offer, check };
}

function counterOrClose(ctx: ToolContext, n: Negotiation, m: Memory): DecideResult {
  const { offer, check } = lastOfferAndCheck(n);
  const c = nextCounter(ctx, n, m, offer, check);
  if (!c) return close(ctx, n.id, LINES.noDeal, 'no_deal');
  return sayCounter(ctx, n, m, c);
}

function sayCounter(ctx: ToolContext, n: Negotiation, m: Memory, c: NonNullable<ReturnType<typeof nextCounter>>): DecideResult {
  m.counters += 1;
  m.lastAsk = c.ask;
  m.askLines = c.lines;
  if (c.ask?.stated && c.ask.fee === 0) m.askedDays.add(c.ask.newDay);
  const say = vary(load(ctx, n.id), c.lines);
  ctx.bus.emit({ type: 'offer.checked', model: 'code', caseId: n.caseId, title: `Countered: "${say}"`, detail: { negotiationId: n.id, ask: c.ask } });
  return reply(ctx, n.id, say, { state: 'countering', pendingOfferId: undefined });
}

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

export async function decide(ctx: ToolContext, negotiationId: string, utterance: string): Promise<DecideResult> {
  if (isScriptedNegotiation(negotiationId)) return scriptedDecide(ctx, negotiationId, utterance);
  return withLock(negotiationId, () => decideLocked(ctx, negotiationId, utterance.trim()));
}

/** "Reference", "confirmation number", "case number": the lender is giving a reference. */
const REF_KEY = /\b(reference|ref|confirmation|confirmation number|case number|ticket number|tracking number)\b/i;

/** The account's own digits ("4417") are never a reference number. */
function refExclusions(ctx: ToolContext, n: Negotiation): string[] {
  return accountReference(ctx, n).match(/\d+/g) ?? [];
}

async function decideLocked(ctx: ToolContext, id: string, utterance: string): Promise<DecideResult> {
  let n = load(ctx, id);
  if (n.channel === 'voice') {
    // Yoshua's answer came in through the orchestrator but was never said on the call: say it now,
    // unless the lender just changed the terms (then the change is answered below, never the old terms).
    const unsaid = unspokenOutcome(ctx, id, utterance);
    if (unsaid) return unsaid;
  }
  // On a call the goodbye was already said: just hang up. A lender who changes the terms during the
  // goodbye (before the call ends) voids the deal: PacePay never leaves agreement hanging on changed terms.
  if (n.state === 'closed') {
    const late = n.channel === 'voice' && n.outcome === 'deal' && endTimers.has(id) ? lateChange(ctx, n, utterance) : null;
    return late ?? { say: n.channel === 'voice' ? '' : LINES.ended[0], next: 'end_call', state: 'closed' };
  }

  // 0. Line noise, echo and fragments: nothing recorded, no state change. Words that might be a real
  // turn get the pending question again (once), never "I didn't catch that".
  const junk = garbage(utterance);
  if (junk) {
    const m0 = mem(n);
    const say = junk === 'repeat' && !m0.saidSayAgain ? restateQuestion(ctx, n, m0) : '';
    if (say) m0.saidSayAgain = true;
    ctx.bus.emit({ type: 'offer.heard', model: 'code', caseId: n.caseId, title: `Ignored a garbled line: "${utterance}"`, detail: { negotiationId: id, reply: say } });
    if (say) return reply(ctx, id, say, {}, n.state === 'awaiting_approval' ? 'await_approval' : 'listen');
    return { say, next: n.state === 'awaiting_approval' ? 'await_approval' : 'listen', state: n.state };
  }

  // The greeting (which ends with the opening ask) is PacePay's first line on both channels. On a
  // call the worker speaks it from the brief; record it here so the transcript and the model see it.
  if (!(n.transcript ?? []).some((l) => l.speaker === 'pacepay')) openingLine(ctx, id);

  // 1. Append the utterance.
  n = load(ctx, id);
  n = appendLines(ctx, id, [line(ctx, 'counterparty', utterance)], n.state === 'opening' ? { state: 'listening' } : {});
  emitLine(ctx, n, 'counterparty', utterance);
  const m = mem(n);
  m.saidSayAgain = false;
  const d0 = day0(ctx);

  // A reference given before PacePay asked ("...and your confirmation number is B4421") is kept for
  // the end of the call; the rest of the line is read as usual.
  let words = utterance;
  const key = REF_KEY.exec(utterance);
  if (key && !n.outcome) {
    const ref = extractReference(utterance.slice(key.index), refExclusions(ctx, n));
    if (ref) {
      m.earlyRef = ref;
      ctx.bus.emit({ type: 'offer.heard', model: 'code', caseId: n.caseId, title: `Lender gave reference ${ref} early`, detail: { negotiationId: id } });
      words = utterance
        .slice(0, key.index)
        .replace(/(?:\b(?:and|your|the|a|our|my|so|here'?s|here is|it'?s|its)\W*)+$/i, '')
        .replace(/[\s,;:-]+$/, '')
        .trim();
    }
  }

  // Real-call situations (IVR menus, voicemail, transfers, account-holder-only, identity probes,
  // prompt injection, hostility): agent/situations.ts, before any offer parsing.
  const sit = situationTurn(ctx, n, m, words || utterance);
  if (sit) return sit;

  // The lender changed or conditioned terms PacePay is holding them to: settle that first.
  if (m.dispute) return onDispute(ctx, n, m, words || utterance);

  // Waiting on Yoshua: a change of terms is answered (never the stale terms later); otherwise the
  // outcome if it's in, or a request to keep holding.
  if (n.state === 'awaiting_approval') return onHold(ctx, n, m, words || utterance);

  // Closing: an outcome is set and PacePay asked for a reference number.
  if (n.outcome) return onReference(ctx, n, m, utterance);

  if (!words) return reply(ctx, id, m.earlyRef && !n.pendingOfferId ? vary(n, ['Thank you, got it.', 'Thanks, I have that.']) + ` ${currentAsk(ctx, n, m)}` : currentAsk(ctx, n, m));

  // Questions about Yoshua's money, who's calling, whether PacePay is a person, or what PacePay wants: a fixed line, no model.
  const preset = presetAnswer(ctx, n, m, words);
  if (preset) {
    ctx.bus.emit({ type: 'offer.heard', model: 'code', caseId: n.caseId, title: `Answered with a fixed line: "${words}"`, detail: { negotiationId: id } });
    return reply(ctx, id, preset);
  }
  const pending = n.pendingOfferId ? n.offers.find((o) => o.id === n.pendingOfferId) : undefined;
  if (HOLDING.test(normalizeReply(words)) && feeIn(digitize(words), false) === null && parseDay(ctx, n, words) === null) return reply(ctx, id, LINES.takeYourTime);

  // A condition on terms PacePay asked about or read back ("yes, but only if he enrolls in autopay"):
  // PacePay never agrees to anything but a day and a fee.
  const asked: Terms | null = pending ? { newDay: pending.newDay, fee: pending.fee } : m.lastAsk && m.lastAsk.stated ? { newDay: m.lastAsk.newDay, fee: m.lastAsk.fee } : null;
  if (asked && CONDITION.test(normalizeReply(words)) && !VERIFY.test(digitize(words))) {
    return startDispute(ctx, n, m, { phase: 'readback', kind: 'condition', basis: asked, asks: 1 });
  }

  // 2. Read the line in code; only what code can't read goes to the model.
  let hedged = isHedge(words);
  let r = readInCode(ctx, n, m, words, pending);
  // "Okay, the thirteenth then, fine, whatever. It's set for Friday the 13th with no fee": a grudging
  // but exact restatement of the terms asked about is a yes. Only a hedge on the terms themselves
  // ("about twenty", "I think so") needs the exact check again.
  if (
    hedged &&
    asked &&
    r?.kind === 'offer' &&
    r.days.includes(asked.newDay) &&
    r.fee === asked.fee &&
    !r.refused.includes(asked.newDay) &&
    !HEDGE.test(normalizeReply(digitize(words)).replace(/\b(whatever|if you say so|fine|i suppose)\b/g, ' '))
  ) {
    hedged = false;
    m.hedges = 0;
  }
  if (!r && hedged && asked) {
    // "Yeah, something like that", "I think so": not a yes to money terms. Read them back exactly.
    ctx.bus.emit({ type: 'offer.heard', model: 'code', caseId: n.caseId, title: `Heard a hedged answer: "${words}"`, detail: { negotiationId: id } });
    return exactReadBack(ctx, n, m, asked, words, pending);
  }
  if (r) {
    ctx.bus.emit({ type: 'offer.heard', model: 'code', caseId: n.caseId, title: `Read "${words}" as ${r.kind.replace('_', ' ')}${hedged ? ' (hedged)' : ''}`, detail: { negotiationId: id, reading: r } });
  } else {
    const waitingFor = pending
      ? `a yes or no to the read-back "${readBackLine(pending, d0)}"`
      : m.lastAsk
        ? `an answer to the ask: ${speakDate(m.lastAsk.newDay, d0)}, ${feeWords(m.lastAsk.fee)}`
        : 'an offer (a day and any fee)';
    try {
      r = readModel(ctx, n, m, words, await classify(ctx, n, words, waitingFor), pending);
      m.modelMisses = 0;
    } catch (err) {
      // Never hang up because a model was slow: the pending question again (in other words).
      ctx.bus.emit({ type: 'step.failed', model: ctx.models.roleFor('decide'), caseId: n.caseId, level: 'warn', title: `Negotiator could not read the lender's words, answered in code: ${(err as Error).message}`, detail: { negotiationId: id } });
      m.modelMisses += 1;
      return reply(ctx, id, restateQuestion(ctx, load(ctx, id), m));
    }
  }
  return act(ctx, load(ctx, id), m, r, words, pending, hedged);
}

/** The goodbye was said on a deal, the call is still up, and the lender changes the terms: void the deal. */
function lateChange(ctx: ToolContext, n: Negotiation, utterance: string): DecideResult | null {
  const basis = approvedOffer(n);
  if (!basis) return null;
  const m = mem(n);
  const ch = detectChange(ctx, n, m, utterance, basis);
  if (!ch || ch === 'same') return null;
  const terms = { newDay: basis.newDay, fee: basis.fee };
  const tc = {
    kind: ch.kind,
    previousTerms: terms,
    ...(ch.proposed ? { newTerms: ch.proposed } : {}),
    afterApproval: true,
    status: 'no_deal' as const,
    at: ctx.clock.now(),
  };
  const closeReason = changeReason(tc, day0(ctx));
  const say = `I'm sorry, I can't agree to a change. Yoshua approved only ${termsWords(ctx, terms)}, so nothing is agreed today, and the payment stays as it is. Goodbye.`;
  m.note = { kind: tc.kind, approved: terms, ...(ch.proposed ? { proposed: ch.proposed } : {}), approvedByYou: true };
  const next = appendLines(ctx, n.id, [line(ctx, 'counterparty', utterance), line(ctx, 'pacepay', say)], { outcome: 'no_deal', termsChange: tc, closeReason });
  setCallStatus(ctx, next, { outcome: 'no_deal' });
  ctx.bus.emit({ type: 'offer.heard', model: 'code', caseId: n.caseId, level: 'warn', title: `Lender changed the terms after the goodbye; deal voided: ${closeReason}`, detail: { negotiationId: n.id } });
  return { say, next: 'end_call', state: 'closed' };
}

/** Where the call is, for situations.ts. */
function situationPhase(n: Negotiation): SituationPhase {
  if (n.state === 'awaiting_approval') return 'holding';
  if (n.outcome === 'deal') return 'approved';
  if (n.outcome) return 'closing';
  const lender = (n.transcript ?? []).filter((l) => l.speaker === 'counterparty').length;
  return lender <= 1 ? 'greeting' : 'negotiating';
}

/** Why a call situation ended the call, in plain words (Negotiation.closeReason; the post-call text uses it). */
const SITUATION_REASON: Partial<Record<string, string>> = {
  voicemail: "I reached the lender's voicemail and left a short message, so nothing was agreed.",
  after_hours: 'The lender was closed, so nothing was agreed.',
  wrong_number: "The number didn't reach the right lender, so nothing was agreed.",
  hostile: 'The lender asked not to be called again, so I ended the call. Nothing was agreed.',
  hangup_signal: 'The call dropped before anything was agreed.',
  authorization_required: 'The lender will only talk to you directly, so nothing was agreed.',
  callback_request: 'The lender asked for a call back later, so nothing was agreed yet.',
};

/** What a closing situation means for the outcome: a confirmed deal stands; nothing else becomes one. */
const SITUATION_OUTCOME: Partial<Record<string, NonNullable<Negotiation['outcome']>>> = { authorization_required: 'handoff_verification' };

/**
 * agent/situations.ts on one lender turn. Null: an ordinary turn (or advisory only), parsed as usual.
 * Otherwise its line (or DTMF tones) and next move, recorded like any other PacePay line.
 */
function situationTurn(ctx: ToolContext, n: Negotiation, m: Memory, text: string): DecideResult | null {
  const h = ctx.store.household();
  const item = h.scheduled.find((s) => s.id === n.itemId || s.id === n.itemId.split(/[@#:]/)[0]);
  const ref = accountReference(ctx, n);
  const last = [...(n.transcript ?? [])].reverse().find((l) => l.speaker === 'pacepay')?.text;
  let r;
  try {
    r = detectSituation(text, {
      ...(last ? { lastPacePayLine: last } : {}),
      phase: situationPhase(n),
      callBrief: {
        lender: counterpartyName(ctx, n),
        accountLast4: /(\d{4})\b/.exec(ref)?.[1] ?? '',
        itemLabel: (item?.label ?? 'payment').toLowerCase(),
        targetDayPhrase: sayDay(ctx, n.callPlan.targetDay),
        feeLimitCents: n.callPlan.feeLimit,
        personName: personName(ctx),
      },
    });
  } catch (err) {
    ctx.bus.emit({ type: 'step.failed', model: 'code', caseId: n.caseId, level: 'warn', title: `Situation check failed: ${(err as Error).message}`, detail: { negotiationId: n.id } });
    return null;
  }
  if (!r || (!r.say && !r.next && !r.dtmf)) return null;
  if (r.kind === 'authorization_required' && r.next !== 'end_call' && VERIFY.test(digitize(text))) {
    // The negotiator's own hand-off: Yoshua will contact them directly; get a reference number.
    if (n.outcome || m.dispute || n.state === 'awaiting_approval') return null;
    ctx.bus.emit({ type: 'offer.heard', model: 'code', caseId: n.caseId, title: 'Call situation: authorization required', detail: { negotiationId: n.id, note: r.note } });
    return reply(ctx, n.id, LINES.verification, { state: 'listening', outcome: 'handoff_verification', pendingOfferId: undefined });
  }
  ctx.bus.emit({ type: 'offer.heard', model: 'code', caseId: n.caseId, title: `Call situation: ${r.kind.replace(/_/g, ' ')}`, detail: { negotiationId: n.id, situation: r.kind, note: r.note, dtmf: r.dtmf } });
  const dtmf = r.dtmf ? { dtmf: r.dtmf } : {};
  if (r.next === 'end_call') {
    if (m.dispute) {
      const res = closeOnChange(ctx, n, m);
      return { ...res, ...(r.say ? {} : { say: res.say }), ...dtmf };
    }
    const keep = n.outcome === 'deal' && !n.termsChange?.status.match(/asking|awaiting/);
    const outcome = keep ? 'deal' : (SITUATION_OUTCOME[r.kind] ?? (n.outcome && n.outcome !== 'deal' ? n.outcome : 'no_deal'));
    if (n.state === 'awaiting_approval') withdrawApproval(ctx, n.id);
    const say = r.say ?? '';
    return { ...close(ctx, n.id, say, outcome, keep ? {} : { closeReason: SITUATION_REASON[r.kind] ?? 'The call ended before anything was agreed.' }), ...dtmf };
  }
  const next: DecideResult['next'] = n.state === 'awaiting_approval' ? 'await_approval' : (r.next ?? 'listen');
  if (!r.say) return { say: '', next, state: n.state, ...dtmf };
  return { ...reply(ctx, n.id, r.say, {}, next), ...dtmf };
}

/** A lender turn while Yoshua decides: a change of terms is answered at once; otherwise his answer or "still checking". */
async function onHold(ctx: ToolContext, n: Negotiation, m: Memory, words: string): Promise<DecideResult> {
  const basis = approvedOffer(n);
  const ch = basis ? detectChange(ctx, n, m, words, basis) : null;
  if (basis && ch && ch !== 'same') {
    const terms = { newDay: basis.newDay, fee: basis.fee };
    // During a re-approval, going back to what Yoshua already approved settles it.
    if (m.approved && ch.proposed && sameTerms(ch.proposed, m.approved)) {
      m.dispute = { phase: 'approved', kind: ch.kind, basis: m.approved, asks: 1 };
      return honorResolved(ctx, n, m, words);
    }
    const a = dealApproval(ctx, n.id);
    const proposed = ch.proposed ? { proposed: ch.proposed } : {};
    if (a && a.status === 'approved') {
      // He already said yes to these terms (that line wasn't said yet): hold the lender to them.
      outcomes.set(a.id, { status: 'approved', say: '', next: 'listen' });
      spoken.add(a.id);
      n = save(ctx, n.id, { state: 'listening' });
      setCallStatus(ctx, n, { status: 'active' });
      return startDispute(ctx, n, m, { phase: 'approved', kind: ch.kind, basis: terms, ...proposed, asks: 1 });
    }
    if (!a || a.status === 'pending') return startDispute(ctx, n, m, { phase: 'hold', kind: ch.kind, basis: terms, ...proposed, asks: 1 });
  }
  const out = await resolveOutcome(ctx, n.id);
  if (out.status === 'pending') {
    const preset = presetAnswer(ctx, n, m, words);
    return reply(ctx, n.id, preset ?? LINES.stillHolding, {}, 'await_approval');
  }
  // Said once: the voice worker's approval poll won't say it again.
  markSpoken(ctx, n.id);
  return { say: out.say ?? LINES.stillHolding[0], next: out.next ?? 'listen', state: load(ctx, n.id).state };
}

/** One reading, one move: read back, ask, hold for Yoshua, or close. */
function act(ctx: ToolContext, n: Negotiation, m: Memory, r: Reading, heard: string, pending: Offer | undefined, hedged = false): DecideResult | Promise<DecideResult> {
  switch (r.kind) {
    case 'say':
      return reply(ctx, n.id, r.text);
    case 'offer':
      return onOffer(ctx, n, m, r, heard, pending, hedged);
    case 'confirm':
      if (pending) {
        // After a hedge only a clear yes confirms money terms ("mm-hm" or "okay" gets the exact read-back again).
        if (hedged || (m.hedges > 0 && !r.strong)) return exactReadBack(ctx, n, m, pending, heard, pending);
        return onConfirm(ctx, n, m, pending);
      }
      if (m.lastAsk) {
        const terms = { newDay: m.lastAsk.newDay, fee: m.lastAsk.fee };
        if (hedged) return exactReadBack(ctx, n, m, terms, heard, undefined);
        // A clear yes to an ask that said the day and the fee is the lender agreeing to those exact terms.
        if (m.lastAsk.stated && r.strong) return acceptTerms(ctx, n, m, terms, heard);
        return readBack(ctx, n, m, terms, heard);
      }
      if (m.askLines === LINES.lowerFee) return reply(ctx, n.id, LINES.whatFee);
      if (m.askLines === LINES.whatDay) return reply(ctx, n.id, LINES.clarifyDay);
      return reply(ctx, n.id, LINES.clarifyOffer);
    case 'deny':
      // A no to the read-back means PacePay heard it wrong.
      if (pending) return reply(ctx, n.id, LINES.clarifyOffer, { state: 'listening', pendingOfferId: undefined });
      // A no to an ask for a day with no fee (the opening ask, a counter, a waiver) turns that day down.
      if (m.lastAsk && m.lastAsk.fee === 0) m.refusedDays.add(m.lastAsk.newDay);
      return onPushback(ctx, n, m);
    case 'refused_days': {
      for (const d of r.days) m.refusedDays.add(d);
      ctx.bus.emit({ type: 'offer.heard', model: 'code', caseId: n.caseId, title: `Lender turned down ${r.days.map((d) => speakDate(d, day0(ctx))).join(' and ')}`, detail: { negotiationId: n.id } });
      if (pending) n = save(ctx, n.id, { pendingOfferId: undefined, state: 'listening' });
      return onPushback(ctx, n, m);
    }
    case 'refusal':
      return onPushback(ctx, n, m, true);
    case 'verification':
      return reply(ctx, n.id, LINES.verification, { state: 'listening', outcome: 'handoff_verification', pendingOfferId: undefined });
  }
}

/** The lender said no to an ask (or refused outright). Counter once more when it makes sense, else an honest no deal. */
function onPushback(ctx: ToolContext, n: Negotiation, m: Memory, refusal = false): DecideResult {
  const hasOffers = n.offers.some((o) => o.readBackConfirmed);
  if (!hasOffers) {
    if (refusal) return close(ctx, n.id, LINES.refusal, 'no_deal');
    // The target day was turned down before any offer: ask for the next acceptable day once, then an open question.
    if (m.counters === 0 && m.refusedDays.size > 0) {
      const c = nextCounter(ctx, n, m, undefined, undefined);
      if (c) return sayCounter(ctx, n, m, c);
    }
    if (m.openQuestionAsked) return close(ctx, n.id, LINES.refusal, 'no_deal');
    m.openQuestionAsked = true;
    m.lastAsk = null;
    m.askLines = LINES.whatDay;
    return reply(ctx, n.id, LINES.whatDay, { state: 'listening', pendingOfferId: undefined });
  }
  if (refusal) {
    if (m.pushbacks >= 1) return close(ctx, n.id, LINES.refusal, 'no_deal');
    m.pushbacks += 1;
  }
  return counterOrClose(ctx, n, m);
}

/** The latest offer the lender made for a day, if any. */
function lastOfferFor(n: Negotiation, day: Day): Offer | undefined {
  return [...n.offers].reverse().find((o) => o.newDay === day);
}

/**
 * An offer: settle the day and fee from the words and the context, then
 * - the same terms as the pending read-back (any wording): a confirmation;
 * - the same terms PacePay just asked for (day and fee said in the ask): agreed, no second read-back;
 * - terms already confirmed and checked ("like I said, Friday with thirty-five"): a no to the current
 *   ask, so the next counter instead of the same read-back again;
 * - otherwise a read-back.
 */
function onOffer(ctx: ToolContext, n: Negotiation, m: Memory, r: Extract<Reading, { kind: 'offer' }>, heard: string, pending: Offer | undefined, hedged = false): DecideResult | Promise<DecideResult> {
  let days = r.days;
  let refused = r.refused;
  // "Not Friday at no fee, but with a thirty-five dollar fee we can": the fee goes with the day turned down.
  if (!days.length && r.fee !== null && refused.length === 1) (days = refused), (refused = []);
  for (const d of refused) m.refusedDays.add(d);

  // Several days offered ("Thursday or Friday"): the target day if it's one of them, else the first.
  let day: Day | null = days.includes(n.callPlan.targetDay) ? n.callPlan.targetDay : (days[0] ?? null);
  if (day === null) {
    if (r.dayWords) {
      ctx.bus.emit({ type: 'offer.heard', model: 'code', caseId: n.caseId, level: 'warn', title: `Heard an offer without a clear day: "${heard}"`, detail: { negotiationId: n.id } });
      return reply(ctx, n.id, LINES.clarifyDay, { state: 'listening', pendingOfferId: undefined });
    }
    // No day said: the day being discussed (a fee named after "how much is the fee?", the read-back,
    // what PacePay last asked for, the lender's last offer). "How it works, but there's a $35 fee"
    // right after "Could we do Friday?" is Friday with a $35 fee.
    day = m.feeDay ?? pending?.newDay ?? m.lastAsk?.newDay ?? n.offers[n.offers.length - 1]?.newDay ?? null;
    if (day === null) return reply(ctx, n.id, LINES.clarifyDay, { state: 'listening', pendingOfferId: undefined });
  }

  // "Friday works, but there'd be a fee": ask how much before anything else.
  if (r.fee === null && r.feeNoAmount) {
    m.feeDay = day;
    return reply(ctx, n.id, LINES.whatFee, { state: 'listening', pendingOfferId: undefined });
  }

  let fee: Cents;
  if (r.fee !== null) fee = r.fee;
  else if (pending && pending.newDay === day) fee = pending.fee;
  else if (m.lastAsk && m.lastAsk.stated && m.lastAsk.newDay === day) fee = m.lastAsk.fee;
  else if (m.feeDay === day) fee = 0;
  else fee = lastOfferFor(n, day)?.fee ?? 0;
  m.feeDay = null;
  const terms = { newDay: day, fee };
  const same = (o: { newDay: Day; fee: Cents }) => o.newDay === terms.newDay && o.fee === terms.fee;

  // "Yeah, Friday, about twenty": the same terms, hedged. Read them back exactly; only a clear yes confirms.
  if (pending && same(pending)) return hedged || m.hedges > 0 ? exactReadBack(ctx, n, m, pending, heard, pending) : onConfirm(ctx, n, m, pending);
  // The exact terms PacePay asked for, said back: agreed. A number code didn't place ("Friday's, um,
  // thirty") could be a fee it misheard, so that gets a read-back instead.
  if (m.lastAsk && m.lastAsk.stated && same(m.lastAsk) && !strayNumber(heard)) return hedged ? exactReadBack(ctx, n, m, terms, heard, undefined) : acceptTerms(ctx, n, m, terms, heard);
  const checked = new Set((n.checks ?? []).map((c) => c.offerId));
  const before = [...n.offers].reverse().find((o) => o.readBackConfirmed && checked.has(o.id) && same(o));
  if (before) {
    ctx.bus.emit({ type: 'offer.heard', model: 'code', caseId: n.caseId, title: `Lender repeated ${speakDate(day, day0(ctx))}, ${feeWords(fee)}: a no to the last ask`, detail: { negotiationId: n.id, offerId: before.id } });
    if (m.lastAsk && m.lastAsk.fee === 0 && m.lastAsk.newDay !== day) m.refusedDays.add(m.lastAsk.newDay);
    return counterOrClose(ctx, pending ? save(ctx, n.id, { pendingOfferId: undefined }) : n, m);
  }
  // "Friday, about twenty bucks": the exact terms back, and only a clear yes confirms them.
  if (hedged) return exactReadBack(ctx, n, m, terms, heard, undefined);
  return readBack(ctx, n, m, terms, heard);
}

/** A number in the line that isn't a date ("the 13th", "November 13", "11/13") or a typed amount. */
function strayNumber(heard: string): boolean {
  const d = digitize(heard)
    .replace(new RegExp(`\\b${MONTH_RE}\\s+\\d{1,2}(st|nd|rd|th)?\\b`, 'g'), ' ')
    .replace(/\b\d{1,2}(st|nd|rd|th)\b|\b\d{1,2}\/\d{1,2}\b/g, ' ');
  return /\d/.test(d);
}

/** Stores the offer as pending and reads it back. */
function readBack(ctx: ToolContext, n: Negotiation, m: Memory, terms: { newDay: Day; fee: Cents }, heard: string, lines?: readonly string[]): DecideResult {
  const d0 = day0(ctx);
  const offer: Offer = { id: newId('offer'), negotiationId: n.id, itemId: n.itemId, newDay: terms.newDay, fee: terms.fee, heard, readBackConfirmed: false };
  m.lastAsk = null;
  m.hedges = 0;
  ctx.bus.emit({
    type: 'offer.heard',
    model: 'code',
    caseId: n.caseId,
    title: `Heard "${speakDate(terms.newDay, d0)}, ${feeWords(terms.fee)}"`,
    detail: { negotiationId: n.id, offer },
  });
  const say = vary(n, lines ?? readBackVariants(ctx, offer));
  ctx.bus.emit({ type: 'offer.read_back', model: 'code', caseId: n.caseId, title: `Read back: "${say}"`, detail: { negotiationId: n.id, offerId: offer.id } });
  return reply(ctx, n.id, say, { offers: [...n.offers, offer], pendingOfferId: offer.id, state: 'reading_back' });
}

/** The lender agreed to the exact terms PacePay asked for: record them as confirmed and check them. */
function acceptTerms(ctx: ToolContext, n: Negotiation, m: Memory, terms: { newDay: Day; fee: Cents }, heard: string): Promise<DecideResult> {
  const offer: Offer = { id: newId('offer'), negotiationId: n.id, itemId: n.itemId, newDay: terms.newDay, fee: terms.fee, heard, readBackConfirmed: false };
  ctx.bus.emit({ type: 'offer.heard', model: 'code', caseId: n.caseId, title: `Lender agreed to the ask: ${speakDate(terms.newDay, day0(ctx))}, ${feeWords(terms.fee)}`, detail: { negotiationId: n.id, offer } });
  m.lastAsk = null;
  return onConfirm(ctx, save(ctx, n.id, { offers: [...n.offers, offer], pendingOfferId: offer.id }), m, offer);
}


/** The lender confirmed the read-back: check it with the engine, then ask Yoshua or counter. */
async function onConfirm(ctx: ToolContext, n: Negotiation, m: Memory, pending: Offer): Promise<DecideResult> {
  const d0 = day0(ctx);
  const confirmed: Offer = { ...pending, readBackConfirmed: true };
  const offers = n.offers.map((o) => (o.id === pending.id ? confirmed : o));
  n = save(ctx, n.id, { offers, pendingOfferId: undefined });
  ctx.bus.emit({ type: 'offer.confirmed', model: 'code', caseId: n.caseId, title: `Lender confirmed ${speakDate(pending.newDay, d0)}, ${feeWords(pending.fee)}`, detail: { negotiationId: n.id, offerId: pending.id } });

  const raw = await runTool('check_offer', { itemId: confirmed.itemId, newDay: confirmed.newDay, fee: confirmed.fee }, ctx, scopeOf(n));
  const check: OfferCheck = { ...raw, offerId: confirmed.id };
  n = save(ctx, n.id, { checks: [...(n.checks ?? []), check] });

  if (!check.pass) return counterOrClose(ctx, n, m);

  const prompt = dealApprovalText({ toDay: check.postsOnDay, fee: confirmed.fee, checkingFloor: ctx.store.rules().checkingFloor, day0Date: d0 });
  // The approval is stored synchronously when the tool starts; only the text to Yoshua takes network
  // time. On a call the hold line goes out at once (no silence after the lender's "yes"); a typed
  // negotiation waits for the text so the console and the thread stay in order.
  const sent = runTool(
    'request_approval',
    { kind: 'deal', prompt, choices: ['yes', 'no'], timeoutMs: DEAL_APPROVAL_TIMEOUT_MS, negotiationId: n.id, ...(n.callId ? { callId: n.callId } : {}) },
    ctx,
    scopeOf(n),
  ).catch((err: Error) => {
    ctx.bus.emit({ type: 'step.failed', model: 'code', caseId: n.caseId, level: 'error', title: `Could not text Yoshua the deal approval: ${err.message}`, detail: { negotiationId: n.id } });
  });
  if (n.channel !== 'voice') await sent;
  const result = reply(ctx, n.id, LINES.checkingWithYoshua, { state: 'awaiting_approval' }, 'await_approval');
  setCallStatus(ctx, load(ctx, n.id), { status: 'holding_for_approval' });
  return result;
}

/**
 * After the outcome line asked for a reference number: capture it ("A 7 7 3 2", "A as in apple,
 * seven seven three two", "it's A7732"); wait while the lender looks it up; ask once more if they
 * moved on without one; then close politely.
 */
function onReference(ctx: ToolContext, n: Negotiation, m: Memory, utterance: string): DecideResult | Promise<DecideResult> {
  const ref = extractReference(utterance, refExclusions(ctx, n));
  const deal = n.outcome === 'deal' ? approvedOffer(n) : undefined;
  // A change to the approved terms comes first: PacePay never closes on terms the lender just changed.
  if (deal && (!ref || /\$|\b(fee|fees|charge|dollars?|bucks|instead|actually|condition|autopay|only if|as long as)\b/i.test(utterance))) {
    const basis = { newDay: deal.newDay, fee: deal.fee };
    // With a reference in the line, read only the clauses that don't carry it.
    const rest = ref
      ? utterance
          .split(/[,;.!?]+|\bbut\b/i)
          .filter((c) => !REF_KEY.test(c) && !extractReference(c, refExclusions(ctx, n)))
          .join(', ')
      : utterance;
    const ch = detectChange(ctx, n, m, rest, basis);
    if (ch && ch !== 'same') return startDispute(ctx, n, m, { phase: 'approved', kind: ch.kind, basis, ...(ch.proposed ? { proposed: ch.proposed } : {}), asks: 1 });
  }
  const t = deal ? termsWords(ctx, deal) : '';
  if (ref) {
    const r = sayReference(n, ref);
    const lines = deal
      ? [`Thank you, reference ${r}. So that's ${t}, as agreed. Have a great day, goodbye.`, `Perfect, that's ${r}, for ${t}. Thanks so much for your help today. Goodbye!`]
      : [`Thank you, reference ${r}. Nothing has been changed yet, and Yoshua will follow up. Goodbye.`, `Got it, ${r}. Thanks for your help. Nothing is changed for now; Yoshua will follow up. Goodbye.`];
    return close(ctx, n.id, lines, n.outcome!, { referenceNumber: ref });
  }
  const plain = normalizeReply(utterance);
  const done = deal
    ? [`Okay. So that's ${t}, as agreed. Thank you for your help, goodbye.`, `Alright. To confirm, it's ${t}, as agreed. Thanks again, goodbye.`]
    : LINES.closeNoReference;
  if (/\b(bye|goodbye|have a (good|great|nice) (one|day|night|evening))\b/.test(plain)) return close(ctx, n.id, done, n.outcome!);
  const looking = HOLDING.test(plain) || /\b(let me (get|grab|find|pull|generate)|getting (that|it|you)|one sec|bear with)\b/.test(plain) || (yesWords(utterance) !== null && plain.split(' ').length <= 3);
  if (looking) {
    if (m.refWaits >= 2) return { say: '', next: 'listen', state: n.state };
    m.refWaits += 1;
    return reply(ctx, n.id, LINES.waitForReference);
  }
  const noneComing = /\b(by|in an?|via|over) (e ?mail|mail|text|letter|the portal|the app)\b|\b(e ?mail|text|mail) (it|you|him|that|a confirmation)\b/.test(plain);
  if (noneComing) return close(ctx, n.id, done, n.outcome!);
  const declines = /\b(no|dont|cant|cannot|not able|unable|wont|there isnt|there is no|theres no|we dont|doesnt)\b/.test(plain.replace(/\bno (charge|fee|fees|problem|worries)\b/g, ''));
  if (declines || m.refAsks >= 1) return close(ctx, n.id, done, n.outcome!);
  m.refAsks += 1;
  return reply(ctx, n.id, LINES.askReferenceAgain);
}

// ---------------------------------------------------------------------------
// Holding the lender to the terms: hedged yeses, and changes during the hold or after Yoshua's yes.
// PacePay never agrees to anything but the exact day and fee Yoshua approved.
// ---------------------------------------------------------------------------

/** What a lender line does to the terms PacePay is holding them to. */
type TermChange = { kind: 'terms' | 'extra_fee' | 'condition' | 'walkback'; proposed?: Terms; feeNoAmount?: boolean };

/** "Yeah, something like that", "pretty much", "I think so", "about twenty": not a yes to money terms. */
const HEDGE =
  /\b(something like (that|this|it)|somethin like that|pretty much|more or less|sort of|kind of|kinda|sorta|i think so|i think|i guess|i believe so|i believe|i suppose|probably|roughly|approximately|ish|around (that|there)|about that|close enough|if you say so|whatever|maybe|not sure|give or take|ballpark|(about|around|like) \d+)\b/;
export function isHedge(words: string): boolean {
  return HEDGE.test(normalizeReply(digitize(words)));
}

/** A condition beyond a day and a fee ("only if he enrolls in autopay"). Tested on normalizeReply text. */
const CONDITION =
  /\b(only if|as long as|provided (that|he|she|they)|on (the )?condition|in exchange|if (he|she|they|yoshua) (enrolls?|signs? up|sets? up|agrees? to|turns on|switches to|signs)|(he|she|they|yoshua|hed|shed|theyd|hell|shell|theyll) (would |will )?(have|has|need|needs|must) to (enroll|sign|set up|agree to|turn on|switch|make a payment|pay today|pay now|send)|enroll\w* in autopay|(sign|set) up (for )?auto ?pay|on auto ?pay|automatic payments|auto draft)\b/;
/** A fee on top of the agreed one ("plus a ten dollar processing fee"). */
const EXTRA_FEE = /\b(plus|additional|extra|on top|another|processing|admin|administrative|convenience|handling)\b/;
const TOTAL = /\b(total|totals|all in|altogether|all together|in all|in fees|combined)\b/;
/** The lender takes the offer back. */
const WALKBACK =
  /\b(never ?mind|take (that|it) back|scratch that|changed (my|our) mind|no longer|not anymore|(offer|deal) (is|s) off|(cant|cannot|wont|not able to|unable to) (do|honor|offer|make|keep|hold) (that|it|this|those)( anymore| after all)?|(system|it) (wont|doesnt) (let|allow) me)\b/;
/** The lender keeps the terms PacePay asked them to honor. */
const HONOR =
  /\b((we|i) (can|will) (do|honor|keep|hold) (that|it|this|those)|(well|ill) (honor|keep|do) (that|it|those)|honor (that|it|those)|keep it (at|as)|leave it (at|as)|(the )?(original|first) (terms|offer|fee) (is|s)? ?fine|thats fine we can do that)\b/;

const sameTerms = (a: Terms, b: Terms) => a.newDay === b.newDay && a.fee === b.fee;

/** "Friday the 13th with a twenty-dollar fee". */
function termsWords(ctx: ToolContext, t: Terms): string {
  return `${sayDay(ctx, t.newDay)} ${feeWords(t.fee)}`;
}

/**
 * What the line does to `basis`: 'same' (the same terms said again), a change (new day and/or fee,
 * an added fee, a condition, a walk-back), or null (nothing about the terms).
 */
function detectChange(ctx: ToolContext, n: Negotiation, m: Memory, words: string, basis: Terms): TermChange | 'same' | null {
  const plain = normalizeReply(words);
  const d = digitize(words);
  if (CONDITION.test(plain) && !VERIFY.test(d)) return { kind: 'condition' };
  const r = readInCode(ctx, n, m, words, undefined);
  if (r?.kind === 'offer') {
    let day: Day;
    if (r.days.length) day = r.days.includes(basis.newDay) ? basis.newDay : r.days[0]!;
    else if (r.refused.includes(basis.newDay)) return { kind: 'walkback' };
    else day = basis.newDay;
    if (r.fee === null) {
      if (r.feeNoAmount && (EXTRA_FEE.test(plain) || basis.fee === 0)) return { kind: 'extra_fee', feeNoAmount: true, ...(day !== basis.newDay ? { proposed: { newDay: day, fee: basis.fee } } : {}) };
      const t = { newDay: day, fee: basis.fee };
      return sameTerms(t, basis) ? 'same' : { kind: 'terms', proposed: t };
    }
    const extra = !r.summed && r.fee !== basis.fee && basis.fee > 0 && EXTRA_FEE.test(plain) && !TOTAL.test(plain);
    const t = { newDay: day, fee: extra ? basis.fee + r.fee : r.fee };
    if (sameTerms(t, basis)) return 'same';
    return { kind: extra || (r.summed && EXTRA_FEE.test(plain)) ? 'extra_fee' : 'terms', proposed: t };
  }
  if (r?.kind === 'refused_days' && r.days.includes(basis.newDay)) return { kind: 'walkback' };
  if (r?.kind === 'refusal' || WALKBACK.test(plain)) return { kind: 'walkback' };
  return null;
}

/** The pending money question after a hedge: the exact terms again; only a clear yes confirms. */
function exactReadBack(ctx: ToolContext, n: Negotiation, m: Memory, terms: Terms, heard: string, pending: Offer | undefined): DecideResult {
  m.hedges += 1;
  // Never the same exact-check more than twice.
  if (m.hedges > 2) {
    m.hedges = 0;
    return reply(ctx, n.id, LINES.clarifyOffer, { state: 'listening', pendingOfferId: undefined });
  }
  const t = termsWords(ctx, terms);
  const lines = [`I need to be exact on this. Is it ${t}? A yes or no is fine.`, `Just so there's no confusion, is it exactly ${t}?`, `To be precise, is that ${t}, yes or no?`];
  if (pending && sameTerms(pending, terms)) return reply(ctx, n.id, lines, { state: 'reading_back' });
  const h = m.hedges;
  const r = readBack(ctx, n, m, terms, heard, lines);
  m.hedges = h;
  return r;
}

/** The question PacePay is waiting on, in other words (never "I didn't catch that" for a real turn). */
function restateQuestion(ctx: ToolContext, n: Negotiation, m: Memory): string {
  if (n.state === 'awaiting_approval' && !m.dispute) return vary(n, LINES.stillHolding);
  if (m.dispute) return honorAsk(ctx, n, m);
  if (n.outcome && n.state !== 'closed') return vary(n, LINES.askReferenceAgain);
  return currentAsk(ctx, n, m);
}

/** PacePay asks the lender to honor the terms it holds them to (or for the total of an added fee). */
function honorAsk(ctx: ToolContext, n: Negotiation, m: Memory): string {
  // The first wording on first use (it says what was approved and why PacePay can't agree), then the others.
  const said = (n.transcript ?? []).filter((l) => l.speaker === 'pacepay').map((l) => l.text);
  const vary = (nn: Negotiation, opts: readonly string[]) => (said.some((x) => x.includes(opts[0]!)) ? varyLine(nn, opts.slice(1)) : opts[0]!);
  const dsp = m.dispute!;
  const t = termsWords(ctx, dsp.basis);
  if (dsp.awaitFee) return vary(n, ['What would the total fee be, all in?', 'And what would the fee come to in total?', 'How much would the fee be in total?']);
  if (dsp.kind === 'condition') {
    return vary(n, [
      `I can only agree to a new date and a fee, with no other conditions. Can you do ${t} without that?`,
      `I'm not able to agree to any conditions on Yoshua's behalf. Is ${t} possible on its own?`,
      `Just the date and the fee is all I can agree to. Can you do ${t}, with nothing else attached?`,
    ]);
  }
  if (dsp.phase === 'approved') {
    return vary(n, [
      `Just to be clear, Yoshua approved ${t}, and I can only agree to exactly that. Can you do ${t}?`,
      `I'm not able to agree to a change. Yoshua approved ${t}. Can you keep it at ${t}?`,
      `The only terms I can confirm are the ones Yoshua approved, ${t}. Can you honor that?`,
      `I need a clear yes or no, please. Can you do ${t}, as Yoshua approved?`,
    ]);
  }
  if (dsp.phase === 'hold') {
    return vary(n, [
      `I'm checking with Yoshua on ${t}, and I can't agree to different terms myself. Can you still do ${t}?`,
      `Just so I'm clear, I'm asking Yoshua about ${t}. Can you keep it at ${t}?`,
      `I can only check ${t} with Yoshua right now. Is ${t} still possible?`,
    ]);
  }
  return vary(n, [`Just to confirm, can you do ${t}?`, `Is ${t} possible?`]);
}

/** The deal approval waiting on Yoshua's answer, if any. */
function openDealApproval(ctx: ToolContext, id: string) {
  const a = dealApproval(ctx, id);
  return a && a.status === 'pending' ? a : undefined;
}

/** Withdraws a pending deal approval: a YES to it can never confirm terms the lender changed. */
function withdrawApproval(ctx: ToolContext, id: string): void {
  const a = openDealApproval(ctx, id);
  if (!a) return;
  timeoutApproval(ctx, a.id);
  const next = ctx.store.patch('approvals', a.id, { answer: 'withdrawn' });
  ctx.bus.publish({ event: 'approval', data: next });
  outcomes.set(a.id, { status: 'pending' });
  spoken.add(a.id);
}

/** The lender changed or conditioned the terms: hold them to the basis (and record it for the dashboard). */
function startDispute(ctx: ToolContext, n: Negotiation, m: Memory, dsp: Dispute): DecideResult {
  m.dispute = dsp;
  m.hedges = 0;
  const afterApproval = dsp.phase === 'approved';
  if (afterApproval) m.approved = dsp.basis;
  const patch: Partial<Negotiation> = {};
  if (dsp.phase !== 'readback') {
    patch.termsChange = {
      kind: dsp.kind === 'unclear' ? 'terms' : dsp.kind,
      previousTerms: dsp.basis,
      ...(dsp.proposed ? { newTerms: dsp.proposed } : {}),
      afterApproval,
      status: 'asking_lender',
      at: ctx.clock.now(),
    };
  }
  if (afterApproval) {
    patch.outcome = undefined;
    patch.state = 'listening';
    // The approved line ("Yoshua approved ... reference number?") must never go out after this.
    const a = dealApproval(ctx, n.id);
    if (a) spoken.add(a.id);
  }
  const t = termsWords(ctx, dsp.basis);
  ctx.bus.emit({
    type: 'offer.heard',
    model: 'code',
    caseId: n.caseId,
    level: 'warn',
    title: `Lender changed the terms ${dsp.phase === 'approved' ? 'after Yoshua approved' : dsp.phase === 'hold' ? 'while PacePay checked with Yoshua' : 'on the read-back'} (${dsp.kind}${dsp.proposed ? `: ${speakDate(dsp.proposed.newDay, day0(ctx))}, ${feeWords(dsp.proposed.fee)}` : ''}); holding them to ${t}`,
    detail: { negotiationId: n.id, dispute: { ...dsp } },
  });
  if (patch.termsChange || afterApproval) n = save(ctx, n.id, patch);
  return reply(ctx, n.id, honorAsk(ctx, n, m), {}, dsp.phase === 'hold' && n.state === 'awaiting_approval' ? 'await_approval' : 'listen');
}

/** A lender turn while PacePay holds them to the basis terms. */
async function onDispute(ctx: ToolContext, n: Negotiation, m: Memory, words: string): Promise<DecideResult> {
  const dsp = m.dispute!;
  const plain = normalizeReply(words);
  const next: DecideResult['next'] = n.state === 'awaiting_approval' ? 'await_approval' : 'listen';
  if (dsp.awaitFee) {
    const fee = feeIn(digitize(words), true);
    if (fee !== null) {
      dsp.awaitFee = false;
      dsp.proposed = { newDay: dsp.proposed?.newDay ?? dsp.basis.newDay, fee };
      if (sameTerms(dsp.proposed, dsp.basis)) return honorResolved(ctx, n, m, words);
      return insist(ctx, n, m, words);
    }
  }
  const ch = detectChange(ctx, n, m, words, dsp.basis);
  const hedged = isHedge(words);
  const yes = yesWords(words);
  // "Okay fine, we'll honor the twenty", "Twenty is fine": every number in the line is the basis
  // fee (or its date), with a plain yes and no "no".
  const [, , dd] = dayToISODate(dsp.basis.newDay, day0(ctx)).split('-').map(Number) as [number, number, number];
  const nums = (digitize(words).match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const onlyBasis = nums.length > 0 && nums.every((x) => x === dsp.basis.fee / 100 || x === dd);
  const negated = /\b(no|not|nope|nah|cant|cannot|wont|isnt|unable)\b/.test(plain);
  const positive = /\b(fine|ok|okay|yes|yeah|yep|yup|sure|honor|keep it|works|alright|all right|deal|we can|i can)\b/.test(plain);
  const backToBasis = !negated && (positive || HONOR.test(plain)) && (!ch || (onlyBasis && ch !== 'same' && ch.kind !== 'condition'));
  if (!hedged && (ch === 'same' || backToBasis || (!ch && yes?.strong))) return honorResolved(ctx, n, m, words);
  if (ch && ch !== 'same') {
    dsp.kind = ch.kind;
    if (ch.proposed) dsp.proposed = ch.proposed;
    if (ch.feeNoAmount && !ch.proposed) dsp.proposed = undefined;
    if (m.approved && ch.proposed && sameTerms(ch.proposed, m.approved) && !sameTerms(dsp.basis, m.approved)) return honorResolved(ctx, n, m, words);
    return insist(ctx, n, m, words);
  }
  if (!hedged && (noWords(words) || /\b(cant|cannot|wont|unable|not able|no way)\b/.test(plain))) return insist(ctx, n, m, words);
  const preset = presetAnswer(ctx, n, m, words);
  if (preset) return reply(ctx, n.id, preset, {}, next);
  if (HOLDING.test(plain)) return reply(ctx, n.id, LINES.takeYourTime, {}, next);
  dsp.asks += 1;
  if (dsp.asks > 3) return closeOnChange(ctx, n, m);
  return reply(ctx, n.id, honorAsk(ctx, n, m), {}, next);
}

/** The lender went back to the terms PacePay held them to. */
async function honorResolved(ctx: ToolContext, n: Negotiation, m: Memory, heard: string): Promise<DecideResult> {
  const dsp = m.dispute!;
  m.dispute = null;
  m.hedges = 0;
  m.reapproval = false;
  const tc = n.termsChange ? { ...n.termsChange, status: 'resolved' as const } : undefined;
  const t = termsWords(ctx, dsp.basis);
  ctx.bus.emit({ type: 'offer.confirmed', model: 'code', caseId: n.caseId, title: `Lender kept ${speakDate(dsp.basis.newDay, day0(ctx))}, ${feeWords(dsp.basis.fee)}`, detail: { negotiationId: n.id } });
  const approvedBasis = m.approved && sameTerms(m.approved, dsp.basis);
  if (dsp.phase === 'approved' || approvedBasis) {
    // Back to the terms Yoshua approved. If a re-approval for other terms is out, it no longer applies.
    withdrawApproval(ctx, n.id);
    const cur = approvedOffer(n);
    if (!cur || !sameTerms(cur, dsp.basis)) n = await recordAgreed(ctx, n, dsp.basis, heard);
    if (m.earlyRef) {
      const r = sayReference(n, m.earlyRef);
      return close(ctx, n.id, [`Thank you. So that's ${t}, exactly as Yoshua approved, and I have reference ${r}. Goodbye.`], 'deal', { referenceNumber: m.earlyRef, ...(tc ? { termsChange: tc } : {}) });
    }
    setCallStatus(ctx, n, { status: 'active' });
    return reply(ctx, n.id, [`Thank you. So that's ${t}, exactly as Yoshua approved. Could I get a reference number for that?`, `Great, thank you. That's ${t}, as Yoshua approved. What's the reference number?`], { outcome: 'deal', state: 'listening', ...(tc ? { termsChange: tc } : {}) });
  }
  if (dsp.phase === 'hold') {
    if (tc) n = save(ctx, n.id, { termsChange: tc });
    if (!openDealApproval(ctx, n.id)) {
      const out = await resolveOutcome(ctx, n.id);
      if (out.status !== 'pending' && out.say) {
        markSpoken(ctx, n.id);
        return { say: out.say, next: out.next ?? 'listen', state: load(ctx, n.id).state };
      }
    }
    return reply(ctx, n.id, [`Thank you. I'm still checking with Yoshua on ${t}.`, `Thanks. I'm still checking ${t} with Yoshua, one moment.`], {}, 'await_approval');
  }
  // On a read-back: the lender dropped the condition, so those terms are agreed as asked.
  const pending = n.pendingOfferId ? n.offers.find((o) => o.id === n.pendingOfferId) : undefined;
  if (pending && sameTerms(pending, dsp.basis)) return onConfirm(ctx, n, m, pending);
  return acceptTerms(ctx, n, m, dsp.basis, heard);
}

/** Records terms the lender agreed to as a confirmed, checked offer (so dealChanges commits them). */
async function recordAgreed(ctx: ToolContext, n: Negotiation, terms: Terms, heard: string): Promise<Negotiation> {
  const offer: Offer = { id: newId('offer'), negotiationId: n.id, itemId: n.itemId, newDay: terms.newDay, fee: terms.fee, heard, readBackConfirmed: true };
  n = save(ctx, n.id, { offers: [...n.offers, offer], pendingOfferId: undefined });
  const raw = await runTool('check_offer', { itemId: offer.itemId, newDay: offer.newDay, fee: offer.fee }, ctx, scopeOf(n));
  return save(ctx, n.id, { checks: [...(n.checks ?? []), { ...raw, offerId: offer.id }] });
}

/**
 * The lender insists on the change. New terms within Yoshua's limits go to Yoshua as a fresh
 * approval (PacePay holds); anything else ends the call without a deal.
 */
async function insist(ctx: ToolContext, n: Negotiation, m: Memory, heard: string): Promise<DecideResult> {
  const dsp = m.dispute!;
  if (dsp.kind === 'extra_fee' && !dsp.proposed && !dsp.awaitFee) {
    dsp.awaitFee = true;
    return reply(ctx, n.id, honorAsk(ctx, n, m), {}, n.state === 'awaiting_approval' ? 'await_approval' : 'listen');
  }
  if (!dsp.proposed) return closeOnChange(ctx, n, m);
  const t = dsp.proposed;
  const d0 = day0(ctx);
  const offer: Offer = { id: newId('offer'), negotiationId: n.id, itemId: n.itemId, newDay: t.newDay, fee: t.fee, heard, readBackConfirmed: true };
  n = save(ctx, n.id, { offers: [...n.offers, offer], pendingOfferId: undefined });
  const raw = await runTool('check_offer', { itemId: offer.itemId, newDay: offer.newDay, fee: offer.fee }, ctx, scopeOf(n));
  const check: OfferCheck = { ...raw, offerId: offer.id };
  n = save(ctx, n.id, { checks: [...(n.checks ?? []), check] });
  // The old question to Yoshua (if still open) is withdrawn either way.
  withdrawApproval(ctx, n.id);
  if (!check.pass) return closeOnChange(ctx, n, m);

  const afterApproval = dsp.phase === 'approved' || (m.approved !== null && sameTerms(m.approved, dsp.basis));
  const prompt = dealChangedApprovalText({ from: dsp.basis, afterApproval, toDay: check.postsOnDay, fee: t.fee, checkingFloor: ctx.store.rules().checkingFloor, day0Date: d0 });
  const sent = runTool(
    'request_approval',
    { kind: 'deal', prompt, choices: ['yes', 'no'], timeoutMs: DEAL_APPROVAL_TIMEOUT_MS, negotiationId: n.id, ...(n.callId ? { callId: n.callId } : {}) },
    ctx,
    scopeOf(n),
  ).catch((err: Error) => {
    ctx.bus.emit({ type: 'step.failed', model: 'code', caseId: n.caseId, level: 'error', title: `Could not text Yoshua the changed terms: ${err.message}`, detail: { negotiationId: n.id } });
  });
  // request_approval stores the approval before its first await: tag it for the dashboard.
  const a = openDealApproval(ctx, n.id);
  if (a) ctx.bus.publish({ event: 'approval', data: ctx.store.patch('approvals', a.id, { previousTerms: dsp.basis, newTerms: t }) });
  if (n.channel !== 'voice') await sent;
  m.dispute = null;
  m.reapproval = true;
  m.changedFrom = { terms: dsp.basis, afterApproval };
  const tc = {
    kind: (dsp.kind === 'unclear' ? 'terms' : dsp.kind) as NonNullable<Negotiation['termsChange']>['kind'],
    previousTerms: dsp.basis,
    newTerms: t,
    afterApproval,
    status: 'awaiting_yoshua' as const,
    ...(a ? { approvalId: a.id } : {}),
    at: n.termsChange?.at ?? ctx.clock.now(),
  };
  ctx.bus.emit({ type: 'approval.requested', model: 'code', caseId: n.caseId, title: `Lender insisted on ${speakDate(t.newDay, d0)}, ${feeWords(t.fee)}: asked Yoshua again`, detail: { negotiationId: n.id, previousTerms: dsp.basis, newTerms: t } });
  const say = vary(n, [
    `I can't agree to ${termsWords(ctx, t)} myself. Let me check that with Yoshua, one moment.`,
    `I'm not able to agree to that on my own. Let me ask Yoshua about ${termsWords(ctx, t)}. Please hold.`,
  ]);
  const result = reply(ctx, n.id, say, { state: 'awaiting_approval', outcome: undefined, termsChange: tc }, 'await_approval');
  setCallStatus(ctx, load(ctx, n.id), { status: 'holding_for_approval' });
  return result;
}

/** "The lender changed the fee to $35 after Yoshua approved $20; PacePay didn't agree. Nothing changed." */
function changeReason(tc: NonNullable<Negotiation['termsChange']>, d0: string): string {
  const fee = (c: Cents) => (c === 0 ? 'no fee' : formatMoney(c));
  const terms = (t: Terms) => `${formatDate(t.newDay, d0)} ${t.fee === 0 ? 'with no fee' : `for ${formatMoney(t.fee)}`}`;
  const when = tc.afterApproval ? 'after Yoshua approved' : 'while PacePay was checking with Yoshua on';
  const tail = tc.status === 'yoshua_declined' ? 'Yoshua said no, so nothing changed.' : "PacePay didn't agree. Nothing changed.";
  const p = tc.previousTerms;
  const q = tc.newTerms;
  if ((tc.kind === 'terms' || tc.kind === 'extra_fee') && q) {
    if (q.newDay === p.newDay) return `The lender changed the fee to ${fee(q.fee)} ${when} ${fee(p.fee)}. ${tail}`;
    if (q.fee === p.fee) return `The lender changed the date to ${formatDate(q.newDay, d0)} ${when} ${formatDate(p.newDay, d0)}. ${tail}`;
    return `The lender changed the terms to ${terms(q)} ${when} ${terms(p)}. ${tail}`;
  }
  if (tc.kind === 'walkback') return `The lender took back the ${terms(p)} offer${tc.afterApproval ? ' after Yoshua approved it' : ''}. Nothing changed.`;
  return `The lender ${tc.kind === 'condition' ? 'added a condition' : 'added another fee'} ${when} ${terms(p)}. ${tail}`;
}

/** Ends the call without a deal because the lender changed the terms. */
function closeOnChange(ctx: ToolContext, n: Negotiation, m: Memory, youDeclined = false): DecideResult {
  const dsp = m.dispute;
  m.dispute = null;
  withdrawApproval(ctx, n.id);
  const d0 = day0(ctx);
  const prev = n.termsChange;
  const kind = (dsp ? (dsp.kind === 'unclear' ? 'terms' : dsp.kind) : prev?.kind) ?? 'terms';
  const basis = dsp?.basis ?? prev?.previousTerms;
  const proposed = dsp?.proposed ?? prev?.newTerms;
  const tc = basis
    ? {
        kind,
        previousTerms: basis,
        ...(proposed ? { newTerms: proposed } : {}),
        afterApproval: prev?.afterApproval ?? (dsp?.phase === 'approved' || (m.approved !== null && sameTerms(m.approved, basis))),
        status: youDeclined ? ('yoshua_declined' as const) : ('no_deal' as const),
        ...(prev?.approvalId ? { approvalId: prev.approvalId } : {}),
        at: prev?.at ?? ctx.clock.now(),
      }
    : undefined;
  const closeReason = tc ? changeReason(tc, d0) : 'The lender changed the terms, so PacePay did not agree. Nothing changed.';
  if (tc) m.note = { kind: tc.kind, approved: tc.previousTerms, ...(tc.newTerms ? { proposed: tc.newTerms } : {}), approvedByYou: tc.afterApproval, youDeclined };
  const nothing = 'So nothing is agreed today, and the payment stays as it is. Yoshua will follow up with you directly. Goodbye.';
  let say: string;
  if (youDeclined) say = `Thanks for holding. Yoshua isn't able to accept ${proposed ? termsWords(ctx, proposed) : 'those terms'}. ${nothing}`;
  else if (kind === 'condition') say = `I'm not able to agree to conditions on Yoshua's behalf. ${nothing}`;
  else if (kind === 'walkback' || !proposed) say = `Understood. ${nothing}`;
  else say = `I'm sorry, I'm not able to agree to ${termsWords(ctx, proposed)}. ${nothing}`;
  ctx.bus.emit({ type: 'offer.checked', model: 'code', caseId: n.caseId, level: 'warn', title: `No deal: ${closeReason}`, detail: { negotiationId: n.id } });
  return close(ctx, n.id, say, 'no_deal', { ...(tc ? { termsChange: tc } : {}), closeReason });
}

/**
 * The voice worker reports the call ended. Returns true when the negotiator settled it (the case
 * then gets its CALL_ENDED from here); false means the caller handles it (no outcome: CALL_FAILED).
 * A call that ends while the lender's change is unsettled closes without a deal.
 */
export function callHungUp(ctx: ToolContext, negotiationId: string): boolean {
  if (sendCallEnded(ctx, negotiationId)) return true;
  const n = ctx.store.getItem('negotiations', negotiationId);
  if (!n) return false;
  if (n.state === 'closed') return true;
  const m = mem(n);
  const tc = n.termsChange;
  const unsettled = m.dispute || (tc && (tc.status === 'asking_lender' || tc.status === 'awaiting_yoshua'));
  if (unsettled) {
    if (!m.dispute && tc) m.dispute = { phase: tc.afterApproval ? 'approved' : 'hold', kind: tc.kind, basis: tc.previousTerms, ...(tc.newTerms ? { proposed: tc.newTerms } : {}), asks: 1 };
    const d0 = day0(ctx);
    const dsp = m.dispute!;
    m.dispute = null;
    withdrawApproval(ctx, negotiationId);
    const next = {
      kind: dsp.kind === 'unclear' ? ('terms' as const) : dsp.kind,
      previousTerms: dsp.basis,
      ...(dsp.proposed ? { newTerms: dsp.proposed } : {}),
      afterApproval: tc?.afterApproval ?? dsp.phase === 'approved',
      status: 'no_deal' as const,
      ...(tc?.approvalId ? { approvalId: tc.approvalId } : {}),
      at: tc?.at ?? ctx.clock.now(),
    };
    const closeReason = `${changeReason(next, d0)} The call ended before it was settled.`;
    save(ctx, negotiationId, { state: 'closed', outcome: 'no_deal', pendingOfferId: undefined, termsChange: next, closeReason });
  } else if (n.outcome) {
    save(ctx, negotiationId, { state: 'closed', pendingOfferId: undefined });
  } else if (n.channel !== 'text') {
    // The lender hung up (or the line dropped) before anything was confirmed: no deal, and Yoshua
    // gets the honest text (orchestrator: post-call summary), never silence.
    withdrawApproval(ctx, negotiationId);
    save(ctx, negotiationId, { state: 'closed', outcome: 'no_deal', pendingOfferId: undefined, closeReason: HUNG_UP_REASON });
  } else return false;
  ctx.enqueue({ id: newId('evt'), at: ctx.clock.now(), type: 'CALL_ENDED', callId: n.callId ?? '', negotiationId });
  return true;
}

/** The close reason when the call ended before anything was confirmed. */
export const HUNG_UP_REASON = 'The lender hung up before confirming anything, so nothing changed.';

/**
 * The deal the case may commit at the end of the call: Yoshua approved it, the lender accepted it,
 * and nothing disputes it. Null otherwise (the orchestrator commits nothing and says so).
 */
export function confirmedDeal(ctx: ToolContext, negotiationId: string): Terms | null {
  const n = ctx.store.getItem('negotiations', negotiationId);
  if (!n || n.outcome !== 'deal') return null;
  const m = mem(n);
  if (m.dispute) return null;
  if (n.termsChange && !['resolved', 'yoshua_approved'].includes(n.termsChange.status)) return null;
  const approved = ctx.store.list('approvals').some((a) => a.kind === 'deal' && a.negotiationId === negotiationId && a.status === 'approved');
  if (!approved) return null;
  const o = approvedOffer(n);
  return o ? { newDay: o.newDay, fee: o.fee } : null;
}

// ---------------------------------------------------------------------------
// The deal approval
// ---------------------------------------------------------------------------

/** The newest deal approval for this negotiation. */
function dealApproval(ctx: ToolContext, negotiationId: string) {
  // Newest first; two approvals in the same millisecond (a re-approval right after a withdrawal) keep insertion order.
  const all = ctx.store.list('approvals').filter((a) => a.kind === 'deal' && a.negotiationId === negotiationId);
  return all
    .map((a, i) => ({ a, i }))
    .sort((x, y) => y.a.requestedAt.localeCompare(x.a.requestedAt) || y.i - x.i)[0]?.a;
}

/** The offer Yoshua is approving: the last confirmed one that passed its check. */
function approvedOffer(n: Negotiation): Offer | undefined {
  const passed = new Set((n.checks ?? []).filter((c) => c.pass).map((c) => c.offerId));
  return [...n.offers].reverse().find((o) => o.readBackConfirmed && passed.has(o.id));
}

/**
 * What PacePay says once the deal approval is resolved (both channels). Idempotent: the first
 * call after Yoshua answers (or the 60 s timeout) appends the line to the transcript, updates the
 * negotiation (approved -> confirm, outcome 'deal'; declined -> counter or close; timeout -> the
 * hold-and-reference line, outcome 'approval_timeout') and publishes it; later calls return the
 * same answer. While the approval is pending it returns { status: 'pending' }.
 * Callers: POST /api/voice/calls/:id/approval (the worker polls it) and the agent on
 * APPROVAL_REPLY / APPROVAL_TIMEOUT for a text negotiation (the lender console shows the line
 * through the `negotiation` SSE event).
 */
export async function approvalOutcome(ctx: ToolContext, negotiationId: string): Promise<VoiceApprovalResponse> {
  if (isScriptedNegotiation(negotiationId)) return scriptedApprovalOutcome(ctx, negotiationId);
  return withLock(negotiationId, () => resolveOutcome(ctx, negotiationId));
}

/** Deal approvals whose outcome line was already handed to the voice worker (by decide or its poll). */
const spoken = new Set<string>();

/** Records that the resolved approval's line went out on the call, so it is never handed out twice. */
function markSpoken(ctx: ToolContext, negotiationId: string): void {
  const a = dealApproval(ctx, negotiationId);
  if (a && outcomes.has(a.id)) spoken.add(a.id);
}

/**
 * The approval outcome for the voice worker's poll (POST /api/voice/calls/:id/approval). Same as
 * approvalOutcome, except that a line decide already returned on this call comes back empty: the
 * approved line ("Yoshua approved ... Could I get a reference number?") is said exactly once.
 */
export async function approvalOutcomeForCall(ctx: ToolContext, negotiationId: string): Promise<VoiceApprovalResponse> {
  if (isScriptedNegotiation(negotiationId)) return scriptedApprovalOutcome(ctx, negotiationId);
  return withLock(negotiationId, async () => {
    const out = await resolveOutcome(ctx, negotiationId);
    if (out.status === 'pending') {
      // Lines likely next, so the worker can synthesize them during the hold (no pause mid-line later).
      const n = load(ctx, negotiationId);
      if (n.state !== 'awaiting_approval' || mem(n).earlyRef) return out;
      return { ...out, prepare: [...approvedLines(n, day0(ctx)), ...LINES.stillHolding] };
    }
    const a = dealApproval(ctx, negotiationId);
    if (a && spoken.has(a.id)) return { ...out, say: '' };
    if (a) spoken.add(a.id);
    return out;
  });
}

/**
 * Yoshua's answer was settled elsewhere (the orchestrator on APPROVAL_REPLY) but its line hasn't
 * gone out on the call yet, and the lender spoke first: say it now (once).
 */
function unspokenOutcome(ctx: ToolContext, id: string, utterance = ''): DecideResult | null {
  const a = dealApproval(ctx, id);
  if (!a || spoken.has(a.id)) return null;
  const out = outcomes.get(a.id);
  if (!out || out.status === 'pending' || !out.say) return null;
  const n = load(ctx, id);
  if (out.status === 'approved' && utterance && n.outcome === 'deal') {
    // The lender changed the terms before hearing Yoshua's yes: answer the change (decide holds them
    // to the approved terms), never "please go ahead" on terms they just changed.
    const basis = approvedOffer(n);
    const ch = basis ? detectChange(ctx, n, mem(n), utterance, basis) : null;
    if (ch && ch !== 'same') return null;
  }
  spoken.add(a.id);
  return { say: out.say, next: out.next === 'end_call' || n.state === 'closed' ? 'end_call' : 'listen', state: n.state };
}

async function resolveOutcome(ctx: ToolContext, id: string): Promise<VoiceApprovalResponse> {
  const a = dealApproval(ctx, id);
  if (!a) return { status: 'pending' };
  const done = outcomes.get(a.id);
  if (done) return done;
  if (a.status === 'pending' || a.status === 'answered') return { status: 'pending' };

  const n = load(ctx, id);
  const d0 = day0(ctx);
  const m = mem(n);
  let out: VoiceApprovalResponse;
  setCallStatus(ctx, n, { status: 'active' });

  if (n.state !== 'awaiting_approval') {
    // Already moved on (e.g. after a restart): report the status with the last line said.
    const last = [...(n.transcript ?? [])].reverse().find((l) => l.speaker === 'pacepay');
    out = { status: a.status, say: last?.text, next: n.state === 'closed' ? 'end_call' : 'listen' };
  } else if (a.status === 'approved' && m.dispute) {
    // The lender changed the terms while Yoshua decided: he approved the old ones, so hold the lender to those.
    m.dispute.phase = 'approved';
    m.approved = m.dispute.basis;
    const t = termsWords(ctx, m.dispute.basis);
    const say = vary(n, [
      `Thanks for holding. Yoshua approved ${t}, and that's the only thing I can agree to. Can you do ${t}?`,
      `Thanks for waiting. Yoshua approved ${t}, and I can't agree to anything different. Can you keep it at ${t}?`,
    ]);
    reply(ctx, id, say, { state: 'listening' });
    out = { status: 'approved', say, next: 'listen' };
  } else if (a.status === 'approved') {
    const offer = approvedOffer(n);
    if (offer) m.approved = { newDay: offer.newDay, fee: offer.fee };
    m.reapproval = false;
    const tc = n.termsChange && n.termsChange.status === 'awaiting_yoshua' ? { termsChange: { ...n.termsChange, status: 'yoshua_approved' as const } } : {};
    if (tc.termsChange) save(ctx, id, tc);
    const terms = offer ? `${speakDate(offer.newDay, d0)}, ${feeWords(offer.fee)}` : '';
    const say = vary(n, approvedLines(n, d0));
    ctx.bus.emit({ type: 'offer.confirmed', model: 'code', caseId: n.caseId, title: 'Deal agreed with the lender after Yoshua approved', detail: { negotiationId: id, offerId: offer?.id } });
    if (m.earlyRef) {
      // The lender already gave a reference: confirm the terms, say it back, and close.
      const r = sayReference(n, m.earlyRef);
      const done = vary(n, [
        `Thanks for holding. Yoshua approved, so please go ahead and move the payment to ${terms || 'those terms'}. I have the reference as ${r}. Thanks so much for your help, goodbye.`,
        `Thanks for waiting. Good news, Yoshua approved. Please go ahead with ${terms || 'that'}, and I have reference ${r}. Thank you, goodbye.`,
      ]);
      const res = close(ctx, id, done, 'deal', { referenceNumber: m.earlyRef });
      out = { status: 'approved', say: res.say, next: 'end_call' };
    } else {
      reply(ctx, id, say, { state: 'listening', outcome: 'deal' });
      out = { status: 'approved', say, next: 'listen' };
    }
  } else if (a.status === 'declined' && (m.reapproval || n.termsChange?.status === 'awaiting_yoshua')) {
    // Yoshua said no to the lender's changed terms: no deal, said plainly.
    m.reapproval = false;
    const r = closeOnChange(ctx, n, m, true);
    out = { status: 'declined', say: r.say, next: 'end_call' };
  } else if (a.status === 'declined') {
    m.dispute = null;
    const r = counterAfterDecline(ctx, load(ctx, id), m);
    out = { status: 'declined', say: r.say, next: r.next === 'end_call' ? 'end_call' : 'listen' };
  } else if (m.dispute || m.reapproval || n.termsChange?.status === 'awaiting_yoshua') {
    // No answer from Yoshua while the terms were in question: never ask the lender to hold changed terms.
    m.dispute = null;
    m.reapproval = false;
    const tc = n.termsChange ? { ...n.termsChange, status: 'no_deal' as const } : undefined;
    const closeReason = tc ? `${changeReason(tc, d0)} Yoshua didn't answer in time.` : "The lender changed the terms and Yoshua didn't answer in time. Nothing changed.";
    const say = "I wasn't able to reach Yoshua just now, so nothing is agreed today, and the payment stays as it is. Yoshua will follow up with you directly. Goodbye.";
    const r = close(ctx, id, say, 'approval_timeout', { ...(tc ? { termsChange: tc } : {}), closeReason });
    out = { status: 'timeout', say: r.say, next: 'end_call' };
  } else {
    const say = vary(n, LINES.holdAndReference);
    reply(ctx, id, say, { state: 'listening', outcome: 'approval_timeout' });
    out = { status: 'timeout', say, next: 'listen' };
  }
  outcomes.set(a.id, out);
  return out;
}

/** The wordings of "Yoshua approved, please go ahead ... reference number?" (vary picks one when he answers). */
function approvedLines(n: Negotiation, d0: string): string[] {
  const offer = approvedOffer(n);
  const terms = offer ? `${speakDate(offer.newDay, d0)}, ${feeWords(offer.fee)}` : '';
  return terms
    ? [
        `Thanks for holding. Yoshua approved. Please go ahead and move the payment to ${terms}. Could I get a reference number for that?`,
        `Thanks for waiting. Good news, Yoshua approved, so please go ahead and move it to ${terms}. Could I get a reference number?`,
        `Okay, I'm back. Yoshua approved. Please go ahead with ${terms}. What's the reference number for that?`,
      ]
    : ['Thanks for holding. Yoshua approved. Could I get a reference number for that?'];
}

/** Yoshua said no to the deal: ask for the target day with no fee if that wasn't it, else an honest no deal. */
function counterAfterDecline(ctx: ToolContext, n: Negotiation, m: Memory): DecideResult {
  const offer = approvedOffer(n);
  const target = n.callPlan.targetDay;
  if (offer && !(offer.newDay === target && offer.fee === 0) && m.counters < MAX_COUNTERS) {
    m.counters += 1;
    m.lastAsk = { newDay: target, fee: 0, stated: true };
    m.askLines = askDayVariants(ctx, target);
    m.askedDays.add(target);
    const lead = vary(n, ["Thanks for holding. Yoshua can't take that one.", "Sorry for the wait. That one won't work for Yoshua."]);
    return reply(ctx, n.id, `${lead} ${vary(n, m.askLines)}`, { state: 'countering' });
  }
  return close(ctx, n.id, `${vary(n, ["Thanks for holding. Yoshua isn't able to take that.", "Sorry for the wait. Yoshua can't take that one."])} ${vary(n, LINES.noDeal)}`, 'no_deal');
}

/**
 * The changes the confirmed deal commits (for the orchestrator's confirm_deal step): the moved
 * payment and its fee, from engine.offerChanges. Empty when there is no approved deal.
 */
export function dealChanges(ctx: ToolContext, negotiationId: string): Change[] {
  const n = load(ctx, negotiationId);
  if (n.outcome !== 'deal') return [];
  const offer = approvedOffer(n);
  if (!offer) return [];
  return ctx.engine.offerChanges(ctx.store.household(), { itemId: offer.itemId, newDay: offer.newDay, fee: offer.fee });
}

/**
 * PacePay's first line, recorded once at the top of the transcript: the lender console's opening
 * line, and on a call the greeting the worker spoke from the brief. It ends with the opening ask.
 */
export function openingLine(ctx: ToolContext, negotiationId: string): string {
  if (isScriptedNegotiation(negotiationId)) return scriptedOpeningLine(ctx, negotiationId);
  const n = load(ctx, negotiationId);
  const existing = (n.transcript ?? []).find((l) => l.speaker === 'pacepay');
  if (existing) return existing.text;
  const text = greetingLine(ctx, n);
  const next = save(ctx, negotiationId, {
    transcript: [line(ctx, 'pacepay', text), ...(n.transcript ?? [])],
    state: n.state === 'opening' ? 'listening' : n.state,
  });
  mem(next).lastAsk = { newDay: n.callPlan.targetDay, fee: 0, stated: false };
  emitLine(ctx, next, 'pacepay', text);
  return text;
}
