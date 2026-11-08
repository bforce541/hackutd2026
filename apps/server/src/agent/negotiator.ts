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
 * - Every new offer is read back ("So that's Friday, Nov 13, with a $20 fee?"). check_offer runs
 *   only after the lender confirms the read-back.
 * - Pass -> deal approval (60 s). Fail -> a counter chosen here: a fee waiver first when only the
 *   fee fails, otherwise the CallPlan's targetDay (then the other acceptable days) with no fee.
 *   No line ever states a reason, a balance, a floor or the fee limit.
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

const LINES = {
  checkingWithYoshua: 'Let me confirm with Yoshua, one moment.',
  stillHolding: "Thanks for holding, I'm still checking with Yoshua.",
  clarifyDay: 'Which exact day would that be?',
  clarifyOffer: 'Sorry, I want to get this right. What day and fee are you offering?',
  whatDay: 'Is there a day you could move it to?',
  waiver: 'Would you be able to waive the fee?',
  lowerFee: 'Is there any way to lower the fee?',
  noDeal: "Thanks for checking. I'll let Yoshua know, and Yoshua can follow up with you directly. Goodbye.",
  refusal: "I understand. Thank you for your time. I'll let Yoshua know. Goodbye.",
  verification:
    "I understand. I can't verify on Yoshua's behalf, so Yoshua will contact you directly. Could I get a reference number for this request?",
  holdAndReference:
    "I wasn't able to reach Yoshua just now. Could you hold that offer and give me a reference number? Yoshua will call you back.",
  waitForReference: "Sure, I'll wait for the reference number.",
  closeNoReference: 'Thank you for your help. Yoshua will follow up. Goodbye.',
  modelFailed: "One moment. Let me check on that and call you back. Thank you, goodbye.",
  ended: 'This conversation has ended. Thank you.',
  privateDetails: "I'm not able to share details about Yoshua's finances.",
  takeYourTime: 'Sure, take your time.',
  sayAgain: 'Sorry, could you say that again?',
  areYouAPerson: "I'm an AI assistant contacting you on Yoshua's behalf, with Yoshua's permission, and this conversation is transcribed.",
} as const;

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Friday, November 13" (reads well spoken and typed). */
function speakDate(day: Day, day0Date: string): string {
  const [, mm, dd] = dayToISODate(day, day0Date).split('-').map(Number) as [number, number, number];
  return `${formatWeekdayLong(day, day0Date)}, ${MONTHS_LONG[mm - 1] ?? formatShortDate(day, day0Date)} ${dd}`;
}

/** The opening ask from the CallPlan: the target day with no fee. Said at the end of the greeting and whenever the lender asks what PacePay wants. */
export function openingAsk(ctx: ToolContext, n: Negotiation): string {
  return `${n.channel === 'text' ? "I'm reaching out" : "I'm calling"} to ask if this month's payment can move to ${speakDate(n.callPlan.targetDay, day0(ctx))}, with no fee.`;
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

function feeWords(fee: Cents): string {
  return fee === 0 ? 'with no fee' : `with a ${formatMoney(fee)} fee`;
}

function readBackLine(o: { newDay: Day; fee: Cents }, day0Date: string): string {
  return `So that's ${speakDate(o.newDay, day0Date)}, ${feeWords(o.fee)}?`;
}

function askDayLine(day: Day, day0Date: string): string {
  return `Could you do ${speakDate(day, day0Date)} instead, with no fee?`;
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
export function parseDayPhrase(phrase: string, today: Day, day0Date: string): Day | null {
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
    for (let d = today + 1; d <= today + 21; d += 1) {
      if (weekdayOf(d, day0Date) !== want) continue;
      if (nextWeek && weekIndex(d) <= weekIndex(today)) continue;
      return d;
    }
    return null;
  }
  return null;
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
  daysAsked: Set<Day>;
  lowerFeeAsked: boolean;
  openQuestionAsked: boolean;
  counters: number;
  pushbacks: number;
  waitedForReference: boolean;
  /** The last ask PacePay said in words (a counter, a waiver, "what day"); repeated when the lender asks what PacePay wants. Null means the opening ask. */
  askLine: string | null;
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
      daysAsked: new Set(),
      lowerFeeAsked: false,
      openQuestionAsked: false,
      counters: 0,
      pushbacks: 0,
      waitedForReference: false,
      askLine: null,
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
function close(ctx: ToolContext, id: string, say: string, outcome: NonNullable<Negotiation['outcome']>, extra: Partial<Negotiation> = {}): DecideResult {
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
function reply(ctx: ToolContext, id: string, say: string, patch: Partial<Negotiation> = {}, next: DecideResult['next'] = 'listen'): DecideResult {
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
  if (pending) return readBackLine(pending, day0(ctx));
  return m.askLine ?? openingAsk(ctx, n);
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
  if (feeAmount(utterance) !== null || parseDayPhrase(utterance, ctx.clock.today(), day0(ctx)) !== null) return null;
  const plain = normalizeReply(utterance);
  if (ASKS_A_QUESTION.test(utterance)) {
    if (ABOUT_BEING_AI.test(utterance)) return LINES.areYouAPerson;
    if (ABOUT_FINANCES.test(utterance)) return `${LINES.privateDetails} ${currentAsk(ctx, n, m)}`;
  }
  if (ABOUT_THE_REQUEST.test(plain)) return currentAsk(ctx, n, m);
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
// Counters (code picks them from the CallPlan)
// ---------------------------------------------------------------------------

const FAILURES = (c: OfferCheck) => c.reasons.filter((r) => r !== 'OK' && r !== 'WEEKEND_ROLLS_FORWARD');

/** The next counter for a failing offer, or null when PacePay has nothing left to ask for. */
function nextCounter(ctx: ToolContext, n: Negotiation, m: Memory, offer: Offer | undefined, check: OfferCheck | undefined): { say: string; ask: Memory['lastAsk'] } | null {
  if (m.counters >= MAX_COUNTERS) return null;
  const d0 = day0(ctx);
  const plan = n.callPlan;
  const failures = check ? FAILURES(check) : [];
  const feeOnly = failures.length > 0 && failures.every((r) => r === 'FEE_OVER_LIMIT');

  // 1. Only the fee fails: ask for a waiver first.
  if (offer && feeOnly && !m.waiverAsked.has(offer.newDay)) {
    m.waiverAsked.add(offer.newDay);
    return { say: LINES.waiver, ask: { newDay: offer.newDay, fee: 0 } };
  }
  // 2. The plan's target day, then the other days that work with no fee.
  const days = [plan.targetDay, ...plan.acceptableDays].filter((d, i, all) => all.indexOf(d) === i && d > ctx.clock.today());
  const nextDay = days.find((d) => !m.daysAsked.has(d) && d !== offer?.newDay);
  if (nextDay !== undefined) {
    m.daysAsked.add(nextDay);
    return { say: askDayLine(nextDay, d0), ask: { newDay: nextDay, fee: 0 } };
  }
  // 3. A lower fee, once.
  if (offer && offer.fee > 0 && !m.lowerFeeAsked) {
    m.lowerFeeAsked = true;
    return { say: LINES.lowerFee, ask: null };
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
  m.counters += 1;
  m.lastAsk = c.ask;
  m.askLine = c.say;
  ctx.bus.emit({ type: 'offer.checked', model: 'code', caseId: n.caseId, title: `Countered: "${c.say}"`, detail: { negotiationId: n.id, ask: c.ask } });
  return reply(ctx, n.id, c.say, { state: 'countering', pendingOfferId: undefined });
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
  if (n.state === 'closed') return { say: LINES.ended, next: 'end_call', state: 'closed' };

  // 0. Line noise, echo and fragments: no reply (or one "say that again"), nothing recorded, no state change.
  const junk = garbage(utterance);
  if (junk) {
    const m0 = mem(n);
    const say = junk === 'repeat' && !m0.saidSayAgain ? LINES.sayAgain : '';
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
    return { say: out.say ?? LINES.stillHolding, next: out.next ?? 'listen', state: load(ctx, id).state };
  }

  // Closing: an outcome is set and PacePay asked for a reference number.
  if (n.outcome) {
    const ref = extractReference(utterance);
    if (ref) {
      const say = n.outcome === 'deal' ? `Thank you, reference ${ref}. Have a great day, goodbye.` : `Thank you, reference ${ref}. Yoshua will follow up. Goodbye.`;
      return close(ctx, id, say, n.outcome, { referenceNumber: ref });
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
  // A line that names a fee, or a day without a "not", carries an offer whatever the model called it
  // ("Friday works, but there's a thirty-five dollar fee" is not a no).
  let kind: Kind = c.kind;
  if (kind !== 'offer' && kind !== 'verification_request') {
    const namesFee = feeAmount(utterance) !== null;
    const namesDay = parseDayPhrase(utterance, ctx.clock.today(), d0) !== null && !/\b(not|no|cant|can't|cannot|won't|wont)\b/i.test(utterance);
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
      if (pending) return reply(ctx, id, LINES.clarifyOffer, { state: 'listening', pendingOfferId: undefined });
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
    if (refusal || m.openQuestionAsked) return close(ctx, n.id, LINES.refusal, 'no_deal');
    m.openQuestionAsked = true;
    m.lastAsk = null;
    m.askLine = LINES.whatDay;
    return reply(ctx, n.id, LINES.whatDay, { state: 'listening' });
  }
  if (refusal) {
    if (m.pushbacks >= 1) return close(ctx, n.id, LINES.refusal, 'no_deal');
    m.pushbacks += 1;
  }
  return counterOrClose(ctx, n, m);
}

function onOffer(ctx: ToolContext, n: Negotiation, m: Memory, utterance: string, c: Classified, pending: Offer | undefined): DecideResult {
  const d0 = day0(ctx);
  const today = ctx.clock.today();
  const phrase = c.offer?.day?.trim() || '';
  let day: Day | null = phrase ? parseDayPhrase(phrase, today, d0) : null;
  if (day === null) day = parseDayPhrase(utterance, today, d0);

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
  const say = readBackLine(offer, d0);
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
    const terms = offer ? ` Please go ahead and move the payment to ${speakDate(offer.newDay, d0)}, ${feeWords(offer.fee)}.` : '';
    const say = `Thanks for holding. Yoshua approved.${terms} Could I get a reference number for that?`;
    ctx.bus.emit({ type: 'offer.confirmed', model: 'code', caseId: n.caseId, title: 'Deal agreed with the lender after Yoshua approved', detail: { negotiationId: id, offerId: offer?.id } });
    reply(ctx, id, say, { state: 'listening', outcome: 'deal' });
    out = { status: 'approved', say, next: 'listen' };
  } else if (a.status === 'declined') {
    const r = counterAfterDecline(ctx, load(ctx, id), m);
    out = { status: 'declined', say: r.say, next: r.next === 'end_call' ? 'end_call' : 'listen' };
  } else {
    reply(ctx, id, LINES.holdAndReference, { state: 'listening', outcome: 'approval_timeout' });
    out = { status: 'timeout', say: LINES.holdAndReference, next: 'listen' };
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
    m.daysAsked.add(target);
    m.lastAsk = { newDay: target, fee: 0 };
    m.askLine = askDayLine(target, day0(ctx));
    const say = `Thanks for holding. Yoshua can't take that one. ${m.askLine}`;
    return reply(ctx, n.id, say, { state: 'countering' });
  }
  return close(ctx, n.id, `Thanks for holding. Yoshua isn't able to take that. ${LINES.noDeal}`, 'no_deal');
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
