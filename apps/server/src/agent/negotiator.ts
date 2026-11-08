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
 * - The model (job 'decide') only classifies the lender's words and extracts { day phrase, fee }.
 *   Code turns the day phrase into a Day on the demo calendar; a phrase it can't pin down
 *   ("early next week") gets a clarifying question.
 * - Every new offer is read back ("Okay, so just to confirm, that's Friday the 13th with a
 *   twenty-dollar fee?"), including bounds like "the latest I can do is Friday". check_offer runs
 *   only after the lender confirms the read-back (or restates the same terms).
 * - Pass -> deal approval (60 s). Fail -> a counter chosen here: a fee waiver first when only the
 *   fee fails, otherwise always the CallPlan's targetDay with no fee, unless the lender explicitly
 *   turned that day down; then the next acceptable day in acceptableDays order.
 *   No line ever states a reason, a balance, a floor or the fee limit.
 * - Every line has 2-4 code-written variants (LINES, vary()) so nothing repeats word-for-word.
 * - Closing: after a deal, a verification request or an approval timeout PacePay asks for a
 *   reference number (outcome set, state still 'listening'); the next lender line closes it.
 * - The confirmed deal's changes are NOT added to acceptedChanges here: the orchestrator's
 *   confirm_deal step does that (dealChanges() below gives it the exact list).
 */
import { z } from 'zod';
import {
  DEAL_APPROVAL_TIMEOUT_MS,
  dealApprovalText,
  dollarsToCents,
  findDollarAmount,
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
    'Great, let me run that by Yoshua real quick.',
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
  noDeal: [
    "Thanks for checking. I'll let Yoshua know, and Yoshua can follow up with you directly. Goodbye.",
    "Okay, thanks for looking into it. I'll pass that along to Yoshua, who can follow up with you directly. Goodbye.",
    "I appreciate you checking. I'll let Yoshua know, and Yoshua will follow up directly. Take care, goodbye.",
  ],
  refusal: [
    "I understand. Thank you for your time. I'll let Yoshua know. Goodbye.",
    "Okay, I understand. Thanks for your time, I'll let Yoshua know. Goodbye.",
    "Got it, thanks for your time today. I'll pass that along to Yoshua. Goodbye.",
  ],
  verification: [
    "I understand. I can't verify on Yoshua's behalf, so Yoshua will contact you directly. Could I get a reference number for this request?",
    "That makes sense. I'm not able to verify for Yoshua, so Yoshua will reach out directly. Could I get a reference number for this request?",
  ],
  holdAndReference: [
    "I wasn't able to reach Yoshua just now. Could you hold that offer and give me a reference number? Yoshua will call you back.",
    "Sorry, I couldn't reach Yoshua just yet. Could you hold that offer and give me a reference number? Yoshua will call you back.",
  ],
  waitForReference: ["Sure, I'll wait for the reference number.", "No rush, I'll hang on for the reference number.", "Of course, I'll wait for the reference number."],
  closeNoReference: [
    'Thank you for your help. Yoshua will follow up. Goodbye.',
    "That's okay, thanks for your help. Yoshua will follow up. Goodbye.",
    'No problem, thanks again. Yoshua will follow up. Goodbye.',
  ],
  modelFailed: ["Sorry, let me check on that and call you back. Thank you, goodbye."],
  ended: ['This conversation has ended. Thank you.'],
  privateDetails: ["I'm not able to share details about Yoshua's finances.", "I'm sorry, I can't share anything about Yoshua's finances.", "That's not something I can share on Yoshua's behalf."],
  takeYourTime: ['Sure, take your time.', "No problem, I'll hold.", 'Of course, take your time.'],
  sayAgain: ['Sorry, could you say that again?', "Sorry, I didn't catch that. Could you say it again?"],
  areYouAPerson: [
    "I'm an AI assistant contacting you on Yoshua's behalf, with Yoshua's permission, and this conversation is transcribed.",
    "I'm an AI assistant, calling with Yoshua's permission, and this conversation is transcribed.",
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
  const said = (n.transcript ?? []).filter((l) => l.speaker === 'pacepay').map((l) => l.text);
  const turn = Math.max(0, said.length - 1);
  const order = options.map((_, i) => options[(turn + i) % options.length]!);
  const openers = new Set(said.flatMap((s) => s.split(/(?<=[.?!])\s+/)).map(opener));
  return (
    order.find((o) => !said.some((s) => s.includes(o)) && !openers.has(opener(o))) ??
    order.find((o) => !said.some((s) => s.includes(o))) ??
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

/** parseDayPhrase for this negotiation: dates as said, bare weekdays after the payment's due day. */
function parseDay(ctx: ToolContext, n: Negotiation, phrase: string): Day | null {
  return parseDayPhrase(phrase, ctx.clock.today(), day0(ctx), dueDay(ctx, n));
}

/** Days from the Monday that starts day 0's week to day 0 (so weeks run Mon-Sun). */
function monOffset(day0Date: string): number {
  const order: Weekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return order.indexOf(weekdayOf(0, day0Date));
}

const NUMBER_WORDS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};

/** A reference number in what the lender said: "A1B2C3", "ref 4 5 6 7 8", "number is R-77812". */
export function extractReference(text: string): string | null {
  let t = ` ${text} `.replace(/[.,;:!?]/g, ' ');
  t = t.replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/gi, (w) => NUMBER_WORDS[w.toLowerCase()] ?? w);
  // Join runs of single characters spoken apart ("A 1 B 2 C 3").
  t = t.replace(/\b(?:[A-Za-z0-9]\s+){2,}[A-Za-z0-9]\b/g, (run) => run.replace(/\s+/g, ''));
  const candidates = t.match(/\b[A-Za-z0-9][A-Za-z0-9-]{3,}\b/g) ?? [];
  const ref = candidates.find((c) => /\d/.test(c) && !/^\d{1,2}(st|nd|rd|th)$/i.test(c));
  return ref ? ref.toUpperCase() : null;
}

// ---------------------------------------------------------------------------
// Per-negotiation memory (what PacePay last asked for, which counters were used)
// ---------------------------------------------------------------------------

interface Memory {
  /** The terms PacePay last asked for (the opening ask, a waiver or a day). A bare "yes" accepts them. */
  lastAsk: { newDay: Day; fee: Cents } | null;
  waiverAsked: Set<Day>;
  /** Days the lender explicitly turned down at no fee ("No" to an ask for that day, "we can't do Friday"). Counters skip them. */
  refusedDays: Set<Day>;
  lowerFeeAsked: boolean;
  openQuestionAsked: boolean;
  counters: number;
  pushbacks: number;
  waitedForReference: boolean;
  /** The last ask PacePay made (a counter, a waiver, "what day"), in all its wordings; said again (in other words) when the lender asks what PacePay wants. Null means the opening ask. */
  askLines: readonly string[] | null;
  /** PacePay already asked the lender to repeat a garbled line (asked once, then silence until a real turn). */
  saidSayAgain: boolean;
}

const memory = new Map<string, Memory>();
const outcomes = new Map<string, VoiceApprovalResponse>();
const locks = new Map<string, Promise<unknown>>();
const MAX_COUNTERS = 4;

function mem(n: Negotiation): Memory {
  let m = memory.get(n.id);
  if (!m) {
    m = {
      lastAsk: { newDay: n.callPlan.targetDay, fee: 0 },
      waiverAsked: new Set(),
      refusedDays: new Set(),
      lowerFeeAsked: false,
      openQuestionAsked: false,
      counters: 0,
      pushbacks: 0,
      waitedForReference: false,
      askLines: null,
      saidSayAgain: false,
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
  ctx.enqueue({ id: newId('evt'), at: ctx.clock.now(), type: 'CALL_ENDED', callId: n.callId ?? '', negotiationId: id });
  return { say, next: 'end_call', state: 'closed' };
}

/** PacePay says a line and keeps listening. */
function reply(ctx: ToolContext, id: string, lines: string | readonly string[], patch: Partial<Negotiation> = {}, next: DecideResult['next'] = 'listen'): DecideResult {
  const say = typeof lines === 'string' ? lines : vary(load(ctx, id), lines);
  const n = appendLines(ctx, id, [line(ctx, 'pacepay', say)], patch);
  emitLine(ctx, n, 'pacepay', say);
  return { say, next, state: n.state };
}

// ---------------------------------------------------------------------------
// The model: classify and extract
// ---------------------------------------------------------------------------

const KINDS = ['offer', 'confirm', 'deny', 'question', 'verification_request', 'refusal', 'chitchat'] as const;
type Kind = (typeof KINDS)[number];

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

const ONES: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** A fee in what the lender said, typed ("$35", "35 dollars") or spoken ("thirty-five dollar fee", "a hundred dollars"). */
export function feeAmount(text: string): Cents | null {
  const typed = findDollarAmount(text);
  if (typed !== null) return typed;
  const t = text.toLowerCase();
  if (/\b(a|one) hundred (dollars?|bucks)\b/.test(t)) return dollarsToCents(100);
  const m = /\b(?:(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\s-](one|two|three|four|five|six|seven|eight|nine))?|(ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)|(one|two|three|four|five|six|seven|eight|nine))\s+(?:dollars?|bucks)\b/.exec(t);
  if (!m) return null;
  const dollars = m[1] ? TENS[m[1]]! + (m[2] ? ONES[m[2]]! : 0) : m[3] ? TEENS[m[3]]! : ONES[m[4]!]!;
  return dollarsToCents(dollars);
}

const YES = /^(y|yes|yep|yeah|yup|ok|okay|correct|right|thats right|thats correct|that is correct|sure|confirmed|exactly)$/;
const NO = /^(n|no|nope|nah|not quite|thats not right|incorrect)$/;

async function classify(ctx: ToolContext, n: Negotiation, utterance: string, waitingFor: string): Promise<Classified> {
  // Plain yes/no needs no model (and keeps the read-back step fast).
  const plain = normalizeReply(utterance);
  if (YES.test(plain)) return { kind: 'confirm', offer: null, say: null };
  if (NO.test(plain)) return { kind: 'deny', offer: null, say: null };

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
  // SPEC §5.4: 4 s on a call. Typed negotiations (lender console, arena) aren't live audio, so they wait longer.
  const timeoutMs = n.channel === 'voice' ? DEFAULT_TIMEOUTS.decide : TEXT_DECIDE_TIMEOUT_MS;
  const r = await ctx.models.chat({ role: 'decide', messages, json: ClassifySchema, timeoutMs, caseId: n.caseId, title: `${modelLabel(ctx)} read the lender's words` });
  return r.json;
}

function modelLabel(ctx: ToolContext): string {
  const role = ctx.models.roleFor('decide');
  return role === 'nemotron-nano' ? 'Nemotron Nano' : role === 'nemotron-super' ? 'Nemotron Super' : role;
}

/**
 * Words a model-written line may not contain (SPEC §5.3, §7.3): money, Yoshua's finances, a reason
 * for wanting the change, or anything that sounds like agreeing to terms (only code agrees, and
 * only after Yoshua approves).
 */
const LEAK_WORDS =
  /\b(balance|pay ?checks?|payday|paid|pays|salary|wages?|income|deposits?|limit|floor|afford\w*|overdra\w*|savings|checking|mortgage|cushion|budget|dollars?|bucks|cents|money|cash|funds?|bills?|rent|repairs?|expenses?|emergenc\w*|unexpected|short|tight|hardship|struggl\w*|trouble|behind|late|debt|owe[sd]?|because|due to|since|reasons?|conflicts?|schedul\w*|hundred|thousand|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|agree\w*|accept\w*|approv\w*|deal|go ahead|sounds good|works for|confirm\w*|authori[sz]e[sd]? (?:me|you|the|this|it|that)|promise\w*)\b/i;

/**
 * Keeps a small-talk answer inside the brief: no money, no reasons, no agreeing, no account numbers
 * beyond the reference. Anything unsafe is replaced by the current ask (never an improvised line).
 */
function safeSay(ctx: ToolContext, n: Negotiation, m: Memory, say: string | null | undefined): string {
  const fallback = currentAsk(ctx, n, m);
  const s = (say ?? '').trim();
  if (!s) return fallback;
  if (/[$%#]/.test(s)) return fallback;
  if (LEAK_WORDS.test(s)) return fallback;
  // The only digits allowed are the account reference's own ("4417").
  const allowed: string[] = accountReference(ctx, n).match(/\d+/g) ?? [];
  const digits = s.match(/\d+/g) ?? [];
  if (digits.some((d) => !allowed.includes(d))) return fallback;
  return s.split(/(?<=[.?!])\s+/).slice(0, 2).join(' ');
}

/** What PacePay is asking for right now, in words: the pending read-back, the last counter, or the opening ask. */
function currentAsk(ctx: ToolContext, n: Negotiation, m: Memory): string {
  const pending = n.pendingOfferId ? n.offers.find((o) => o.id === n.pendingOfferId) : undefined;
  if (pending) return vary(n, readBackVariants(ctx, pending));
  return vary(n, m.askLines ?? openingAskAgain(ctx, n));
}

const ASKS_A_QUESTION = /\?|^\s*(what|why|how|when|where|who|which|is|are|does|do|did|can|could|would|will|tell me|explain)\b/i;
/** Fishing for Yoshua's finances, his reasons, or PacePay's limits. "Why are you calling" is about the request, not a reason. */
const ABOUT_FINANCES =
  /\b(why(?! (are|were|did) you (calling|call|reaching))|reasons?|balance|paid|pay ?checks?|payday|salary|wages?|income|savings|checking account|afford\w*|money|funds|cash|bills?|budget|financ\w*|trouble|struggl\w*|hardship|limit|floor|the most|max(imum)?|how much|willing to pay|bounce|overdra\w*|short on|behind on|other (payments|loans|debts?|accounts?))\b/i;
const ABOUT_BEING_AI = /\b(real person|a person|human|robot|a bot|an ai|automated|machine|recording|recorded)\b/i;
/**
 * Ordinary questions about the request itself ("How can I help?", "Do you not want to move the
 * payment?", "Which payment?", "What date?"): the answer is the ask. Tested on normalizeReply text
 * (lowercase, no punctuation or apostrophes).
 */
const ABOUT_THE_REQUEST =
  /\b(how (can|may|could) (i|we) help|what can (i|we) do|what do you (need|want)|what (did|do|would) you (need|want|like)|what would you like|what are you (asking|calling|looking)|whats (this|it) (about|regarding)|what is (this|it) (about|regarding)|(why|what) (are|were|did) you (calling|call|reaching)|which (payment|account|loan|one|bill)|what (payment|account|loan)|(what|which) (date|day)|when (do|would) you (want|like)|(do|did) you (not )?(want|need) (to|me to|us to) move|you (want|need|would like) (to|me to|us to) move|move (the|which|what|my|your|his|this) payment|(say|repeat) (that|it) again|repeat that|come again|pardon|what was that)\b/;
/** "Hold on, let me pull that up": the lender is working on it. */
const HOLDING = /\b(hold on|one (moment|sec|second|minute)|just a (moment|sec|second|minute)|give me a (moment|sec|second|minute)|let me (pull|check|look|see|find|bring)|bear with me|pulling (it|that|the account) up)\b/;

/**
 * Lender questions code answers without the model: whether PacePay is a person, anything about
 * Yoshua's money or why he wants the change, and what PacePay is asking for. Lines that carry an
 * offer (a day or an amount) still go to the model, which only extracts the offer from them.
 */
function presetAnswer(ctx: ToolContext, n: Negotiation, m: Memory, utterance: string): string | null {
  if (feeAmount(utterance) !== null || parseDay(ctx, n, utterance) !== null) return null;
  const plain = normalizeReply(utterance);
  if (ASKS_A_QUESTION.test(utterance)) {
    if (ABOUT_BEING_AI.test(utterance)) return vary(n, LINES.areYouAPerson);
    if (ABOUT_FINANCES.test(utterance)) return `${vary(n, LINES.privateDetails)} ${currentAsk(ctx, n, m)}`;
  }
  // "No, we can't move the payment" is a refusal for the model, not a question about the request.
  if (ABOUT_THE_REQUEST.test(plain) && !/\b(cant|cannot|wont|unable|not able)\b/.test(plain)) return currentAsk(ctx, n, m);
  return null;
}

// ---------------------------------------------------------------------------
// Garbage turns (line noise, echo, half-heard fragments)
// ---------------------------------------------------------------------------

/** Short replies that mean something on their own ("Yes.", "Sure.", "Hello?"). */
const SHORT_OK =
  /^(y|yes|yeah|yep|yup|ya|yah|no|n|nope|nah|ok|okay|k|sure|correct|right|done|fine|great|perfect|hello|hi|hey|thanks|thank you|go ahead|hold on|one moment|one sec|sorry|pardon|what|huh|deal|absolutely|alright|all right|of course|got it|sounds good|that works|thats right|thats fine|thats correct|no problem|not really|bye|goodbye|uh huh|mhm|mm hmm|yes please|no thanks|i can|we can|i cant|we cant|it is|it does|you too)$/;
/** Words that make a short line a real turn. */
const CONTENT_WORDS =
  /\b(i|im|ill|ive|id|we|were|well|weve|wed|you|your|youre|he|hes|his|him|she|shes|her|they|their|can|could|would|will|cant|wont|dont|do|does|did|is|are|was|not|what|whats|which|when|whens|why|how|hows|who|whos|where|wheres|yes|no|move|moved|moving|payment|pay|fee|fees|waive|waived|charge|day|date|week|month|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|dollars?|reference|number|account|loan|hold|moment|second|minute|wait|verify|help|sorry|okay|sure|fine|works|thats|deal|done|customer|yoshua|person|ai|calling|call)\b/;

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
  if (SHORT_OK.test(plain)) return null;
  if (ABOUT_BEING_AI.test(utterance) || ABOUT_FINANCES.test(utterance) || ABOUT_THE_REQUEST.test(plain)) return null;
  const words = plain.split(' ').filter(Boolean);
  if (words.length > 5 || CONTENT_WORDS.test(plain)) return null;
  return words.length <= 1 ? 'silent' : 'repeat';
}

// ---------------------------------------------------------------------------
// Offers vs. a day turned down
// ---------------------------------------------------------------------------

/** "No fee" and friends aren't a no. */
const NOT_A_NO = /\b(no (fee|fees|charge|cost|extra charge|problem|worries)|not a problem|without (a|any) fee)\b/gi;
const NEGATION = /\b(not|no|nope|can't|cant|cannot|won't|wont|unable|isn't|isnt|doesn't|doesnt|don't|dont)\b/i;
/** "The latest I can do is X", "nothing beyond X", "we can only do X": X is on the table. */
const BOUND = /\b(latest|earliest|furthest|farthest|beyond|past|later than|after|up to|until|at most|only|best i can|most i can)\b/i;
const WEEKDAY_NAMES = /\b(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?\b/gi;

/**
 * The one day the lender explicitly turned down ("We can't do Friday", "Friday won't work"), or null.
 * Not a refusal: a bound ("the latest I can do is Friday", "I can't go beyond Friday"), "no fee", or
 * a line naming two days ("Wednesday's out, but Friday works": the model picks the offer).
 */
function dayRefusal(ctx: ToolContext, n: Negotiation, utterance: string): Day | null {
  const day = parseDay(ctx, n, utterance);
  if (day === null) return null;
  const t = utterance.replace(/[\u2018\u2019]/g, "'").replace(NOT_A_NO, ' ');
  if (!NEGATION.test(t) || BOUND.test(t)) return null;
  const weekdays = new Set((t.match(WEEKDAY_NAMES) ?? []).map((w) => w.toLowerCase().slice(0, 3)));
  if (weekdays.size > 1) return null;
  return day;
}

// ---------------------------------------------------------------------------
// Counters (code picks them from the CallPlan)
// ---------------------------------------------------------------------------

const FAILURES = (c: OfferCheck) => c.reasons.filter((r) => r !== 'OK' && r !== 'WEEKEND_ROLLS_FORWARD');

/**
 * The next counter for a failing offer, or null when PacePay has nothing left to ask for.
 * 1. Only the fee fails: ask for a waiver on that day (once per day).
 * 2. Otherwise always the CallPlan's targetDay with no fee, unless the lender explicitly turned that
 *    day down; then the next acceptable day, in acceptableDays order, that wasn't turned down.
 * 3. A lower fee, once.
 */
function nextCounter(ctx: ToolContext, n: Negotiation, m: Memory, offer: Offer | undefined, check: OfferCheck | undefined): { lines: string[]; ask: Memory['lastAsk'] } | null {
  if (m.counters >= MAX_COUNTERS) return null;
  const plan = n.callPlan;
  const failures = check ? FAILURES(check) : [];
  const feeOnly = failures.length > 0 && failures.every((r) => r === 'FEE_OVER_LIMIT');

  if (offer && feeOnly && !m.waiverAsked.has(offer.newDay)) {
    m.waiverAsked.add(offer.newDay);
    return { lines: [...LINES.waiver], ask: { newDay: offer.newDay, fee: 0 } };
  }
  // A day already asked for as a waiver is that day with no fee: asking it again is not a new counter.
  const days = [plan.targetDay, ...plan.acceptableDays].filter((d, i, all) => all.indexOf(d) === i && d > ctx.clock.today());
  const nextDay = days.find((d) => !m.refusedDays.has(d) && !(d === offer?.newDay && m.waiverAsked.has(d)));
  if (nextDay !== undefined) return { lines: askDayVariants(ctx, nextDay), ask: { newDay: nextDay, fee: 0 } };

  if (offer && offer.fee > 0 && !m.lowerFeeAsked) {
    m.lowerFeeAsked = true;
    return { lines: [...LINES.lowerFee], ask: null };
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

async function decideLocked(ctx: ToolContext, id: string, utterance: string): Promise<DecideResult> {
  let n = load(ctx, id);
  if (n.state === 'closed') return { say: LINES.ended[0], next: 'end_call', state: 'closed' };

  // 0. Line noise, echo and fragments: no reply (or one "say that again"), nothing recorded, no state change.
  const junk = garbage(utterance);
  if (junk) {
    const m0 = mem(n);
    const say = junk === 'repeat' && !m0.saidSayAgain ? vary(n, LINES.sayAgain) : '';
    if (say) m0.saidSayAgain = true;
    ctx.bus.emit({ type: 'offer.heard', model: 'code', caseId: n.caseId, title: `Ignored a garbled line: "${utterance}"`, detail: { negotiationId: id, reply: say } });
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

  // Waiting on Yoshua: answer with the outcome if it's in, otherwise ask them to keep holding.
  if (n.state === 'awaiting_approval') {
    const out = await resolveOutcome(ctx, id);
    if (out.status === 'pending') return reply(ctx, id, LINES.stillHolding, {}, 'await_approval');
    // resolveOutcome already said its line; return it again for this turn.
    return { say: out.say ?? LINES.stillHolding[0], next: out.next ?? 'listen', state: load(ctx, id).state };
  }

  // Closing: an outcome is set and PacePay asked for a reference number.
  if (n.outcome) {
    const ref = extractReference(utterance);
    if (ref) {
      const r = sayReference(n, ref);
      const lines =
        n.outcome === 'deal'
          ? [`Thank you, reference ${r}. Have a great day, goodbye.`, `Perfect, that's ${r}. Thanks so much for your help today. Goodbye!`, `Great, I've got reference ${r}. Thanks again, have a good one. Goodbye.`]
          : [`Thank you, reference ${r}. Yoshua will follow up. Goodbye.`, `Got it, ${r}. Thanks for your help, Yoshua will follow up. Goodbye.`];
      return close(ctx, id, lines, n.outcome, { referenceNumber: ref });
    }
    const declines = /\b(no|don't|dont|can't|cant|cannot|not able|unable|won't|wont)\b/i.test(utterance);
    if (!declines && !m.waitedForReference) {
      m.waitedForReference = true;
      return reply(ctx, id, LINES.waitForReference);
    }
    return close(ctx, id, LINES.closeNoReference, n.outcome);
  }

  // Questions about Yoshua's money, his reasons, whether PacePay is a person, or what PacePay wants: a fixed line, no model.
  const preset = presetAnswer(ctx, n, m, utterance);
  if (preset) {
    ctx.bus.emit({ type: 'offer.heard', model: 'code', caseId: n.caseId, title: `Answered a question with a fixed line: "${utterance}"`, detail: { negotiationId: id } });
    return reply(ctx, id, preset);
  }

  // 2. Classify and extract.
  const pending = n.pendingOfferId ? n.offers.find((o) => o.id === n.pendingOfferId) : undefined;
  const waitingFor = pending
    ? `a yes or no to the read-back "${readBackLine(pending, d0)}"`
    : m.lastAsk
      ? `an answer to the ask: ${speakDate(m.lastAsk.newDay, d0)}, ${feeWords(m.lastAsk.fee)}`
      : 'an offer (a day and any fee)';
  let c: Classified;
  try {
    c = await classify(ctx, n, utterance, waitingFor);
  } catch (err) {
    ctx.bus.emit({ type: 'step.failed', model: ctx.models.roleFor('decide'), caseId: n.caseId, level: 'error', title: `Negotiator could not read the lender's words: ${(err as Error).message}`, detail: { negotiationId: id } });
    return close(ctx, id, LINES.modelFailed, 'no_deal');
  }
  // Code has the last word on offers and refusals of a day, whatever the model called the line:
  // - "We can't do Friday" turns that one day down (a no, not a refusal of the whole request);
  // - a fee, or a day that isn't turned down, is an offer: "Friday works, but there's a thirty-five
  //   dollar fee", "The latest I can offer is Friday, November 13 with no fee", "How about Friday?".
  let kind: Kind = c.kind;
  const namesFee = feeAmount(utterance) !== null;
  const refusedDay = kind !== 'verification_request' && !namesFee ? dayRefusal(ctx, n, utterance) : null;
  if (refusedDay !== null) {
    m.refusedDays.add(refusedDay);
    ctx.bus.emit({ type: 'offer.heard', model: 'code', caseId: n.caseId, title: `Lender turned down ${speakDate(refusedDay, d0)} (model said ${kind})`, detail: { negotiationId: id } });
    kind = 'deny';
  } else if (kind !== 'offer' && kind !== 'verification_request') {
    const namesDay = parseDay(ctx, n, utterance) !== null;
    if (namesFee || namesDay) {
      ctx.bus.emit({ type: 'offer.heard', model: 'code', caseId: n.caseId, title: `Read "${utterance}" as an offer (model said ${kind})`, detail: { negotiationId: id } });
      kind = 'offer';
    }
  }

  switch (kind) {
    case 'offer':
      return onOffer(ctx, n, m, utterance, c, pending);
    case 'confirm':
      if (pending) return onConfirm(ctx, n, m, pending);
      if (m.lastAsk) return readBack(ctx, n, m, { newDay: m.lastAsk.newDay, fee: m.lastAsk.fee }, utterance);
      return reply(ctx, id, LINES.clarifyOffer);
    case 'deny':
      // A no to the read-back means PacePay heard it wrong, unless the lender just turned that day down.
      if (pending && refusedDay === null) return reply(ctx, id, LINES.clarifyOffer, { state: 'listening', pendingOfferId: undefined });
      // A no to an ask for a day with no fee (the opening ask, a counter, a waiver) turns that day down.
      if (!pending && m.lastAsk && m.lastAsk.fee === 0) m.refusedDays.add(m.lastAsk.newDay);
      return onPushback(ctx, n, m);
    case 'refusal':
      return onPushback(ctx, n, m, true);
    case 'verification_request':
      return reply(ctx, id, LINES.verification, { state: 'listening', outcome: 'handoff_verification', pendingOfferId: undefined });
    case 'question':
    case 'chitchat': {
      if (HOLDING.test(normalizeReply(utterance))) return reply(ctx, id, LINES.takeYourTime);
      // Before any offer is on the table the only thing worth saying is the ask itself.
      if (n.offers.length === 0 && !pending) return reply(ctx, id, currentAsk(ctx, n, m));
      return reply(ctx, id, safeSay(ctx, n, m, c.say));
    }
  }
}

/** The lender said no to an ask (or refused outright). Counter once more when it makes sense, else an honest no deal. */
function onPushback(ctx: ToolContext, n: Negotiation, m: Memory, refusal = false): DecideResult {
  const hasOffers = n.offers.length > 0;
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

function onOffer(ctx: ToolContext, n: Negotiation, m: Memory, utterance: string, c: Classified, pending: Offer | undefined): DecideResult | Promise<DecideResult> {
  const d0 = day0(ctx);
  const today = ctx.clock.today();
  const phrase = c.offer?.day?.trim() || '';
  let day: Day | null = phrase ? parseDay(ctx, n, phrase) : null;
  if (day === null) day = parseDay(ctx, n, utterance);

  // An amount written in the utterance is exact; otherwise the model's number (it hears "twenty dollars").
  let fee: Cents | null = feeAmount(utterance);
  const dollars = feeDollars(c.offer?.fee);
  if (fee === null && dollars !== null) fee = dollarsToCents(dollars);
  if (fee === null && /\b(no fee|without (a|any) fee|no charge|free of charge|waive)/i.test(utterance)) fee = 0;

  const saidADay = phrase !== '' || /\b(week|month|day|days|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(utterance);
  if (day === null && !saidADay) {
    // A fee on its own (or a bare "we can do that") refers to the terms already on the table.
    const prior = pending ?? (fee !== null ? n.offers[n.offers.length - 1] : undefined);
    day = prior?.newDay ?? m.lastAsk?.newDay ?? null;
    if (fee === null && prior === undefined && m.lastAsk) fee = m.lastAsk.fee;
  }
  if (day === null) {
    ctx.bus.emit({ type: 'offer.heard', model: ctx.models.roleFor('decide'), caseId: n.caseId, level: 'warn', title: `Heard an offer without a clear day: "${utterance}"`, detail: { negotiationId: n.id, phrase } });
    return reply(ctx, n.id, LINES.clarifyDay, { state: 'listening', pendingOfferId: undefined });
  }
  // The read-back's own terms said again ("Yes, Wednesday, November 11, no fee. Does that work?") confirm it.
  if (pending && day === pending.newDay && (fee === null || fee === pending.fee)) return onConfirm(ctx, n, m, pending);
  return readBack(ctx, n, m, { newDay: day, fee: fee ?? 0 }, utterance);
}

/** Stores the offer as pending and reads it back. */
function readBack(ctx: ToolContext, n: Negotiation, m: Memory, terms: { newDay: Day; fee: Cents }, heard: string): DecideResult {
  const d0 = day0(ctx);
  const offer: Offer = { id: newId('offer'), negotiationId: n.id, itemId: n.itemId, newDay: terms.newDay, fee: terms.fee, heard, readBackConfirmed: false };
  m.lastAsk = null;
  ctx.bus.emit({
    type: 'offer.heard',
    model: ctx.models.roleFor('decide'),
    caseId: n.caseId,
    title: `Heard "${speakDate(terms.newDay, d0)}, ${feeWords(terms.fee)}"`,
    detail: { negotiationId: n.id, offer },
  });
  const say = vary(n, readBackVariants(ctx, offer));
  ctx.bus.emit({ type: 'offer.read_back', model: 'code', caseId: n.caseId, title: `Read back: "${say}"`, detail: { negotiationId: n.id, offerId: offer.id } });
  return reply(ctx, n.id, say, { offers: [...n.offers, offer], pendingOfferId: offer.id, state: 'reading_back' });
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
  await runTool(
    'request_approval',
    { kind: 'deal', prompt, choices: ['yes', 'no'], timeoutMs: DEAL_APPROVAL_TIMEOUT_MS, negotiationId: n.id, ...(n.callId ? { callId: n.callId } : {}) },
    ctx,
    scopeOf(n),
  );
  const result = reply(ctx, n.id, LINES.checkingWithYoshua, { state: 'awaiting_approval' }, 'await_approval');
  setCallStatus(ctx, load(ctx, n.id), { status: 'holding_for_approval' });
  return result;
}

// ---------------------------------------------------------------------------
// The deal approval
// ---------------------------------------------------------------------------

/** The newest deal approval for this negotiation. */
function dealApproval(ctx: ToolContext, negotiationId: string) {
  return ctx.store
    .list('approvals')
    .filter((a) => a.kind === 'deal' && a.negotiationId === negotiationId)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
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
  } else if (a.status === 'approved') {
    const offer = approvedOffer(n);
    const terms = offer ? `${speakDate(offer.newDay, d0)}, ${feeWords(offer.fee)}` : '';
    const say = vary(
      n,
      terms
        ? [
            `Thanks for holding. Yoshua approved. Please go ahead and move the payment to ${terms}. Could I get a reference number for that?`,
            `Thanks for waiting. Good news, Yoshua approved, so please go ahead and move it to ${terms}. Could I get a reference number?`,
            `Okay, I'm back. Yoshua approved. Please go ahead with ${terms}. What's the reference number for that?`,
          ]
        : ['Thanks for holding. Yoshua approved. Could I get a reference number for that?'],
    );
    ctx.bus.emit({ type: 'offer.confirmed', model: 'code', caseId: n.caseId, title: 'Deal agreed with the lender after Yoshua approved', detail: { negotiationId: id, offerId: offer?.id } });
    reply(ctx, id, say, { state: 'listening', outcome: 'deal' });
    out = { status: 'approved', say, next: 'listen' };
  } else if (a.status === 'declined') {
    const r = counterAfterDecline(ctx, load(ctx, id), m);
    out = { status: 'declined', say: r.say, next: r.next === 'end_call' ? 'end_call' : 'listen' };
  } else {
    const say = vary(n, LINES.holdAndReference);
    reply(ctx, id, say, { state: 'listening', outcome: 'approval_timeout' });
    out = { status: 'timeout', say, next: 'listen' };
  }
  outcomes.set(a.id, out);
  return out;
}

/** Yoshua said no to the deal: ask for the target day with no fee if that wasn't it, else an honest no deal. */
function counterAfterDecline(ctx: ToolContext, n: Negotiation, m: Memory): DecideResult {
  const offer = approvedOffer(n);
  const target = n.callPlan.targetDay;
  if (offer && !(offer.newDay === target && offer.fee === 0) && m.counters < MAX_COUNTERS) {
    m.counters += 1;
    m.lastAsk = { newDay: target, fee: 0 };
    m.askLines = askDayVariants(ctx, target);
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
  mem(next).lastAsk = { newDay: n.callPlan.targetDay, fee: 0 };
  emitLine(ctx, next, 'pacepay', text);
  return text;
}
