/**
 * The scripted agent (SPEC §10.1): walks the repair case with UI.md's exact texts and no model
 * calls, so the dashboard and demo:e2e work before the real agent. Implemented by: agent-stub.
 * Uses the engine for numbers and the templates in @pacepay/shared for every text.
 * It keeps the same contracts as the real agent (see the orchestrator.ts header): states through
 * machine.ts, texts through the tools or messaging/outbox.ts, approvals through request_approval,
 * SSE `case` after every change, so the dashboard and demo:e2e cannot tell the two apart.
 *
 * What it does, by event:
 *   BILL_PHOTO      ack, chart, options approval (option 1 = the call) -> CHOICE_REPLY
 *   CHOICE_REPLY 1  limits approval -> APPROVAL_REPLY yes -> calling -> scripted negotiation
 *   CHOICE_REPLY 2/3 how-to text, case done          APPROVAL_REPLY no -> next-best options, done
 *   deal approval   yes -> confirmed, CALL_ENDED -> "Done" text + reminder follow-up; no -> no deal
 *   CD_MATURING     the CD alert (an option_choice approval), the reply schedules the steps text
 *
 * The scripted negotiation (scriptedDecide / scriptedApprovalOutcome, exported below) is what the
 * lender console and the voice worker talk to for every negotiation this agent opens. Those ids
 * start with `neg_stub_`; isScriptedNegotiation() tells them apart. createStubAgent also wraps the
 * registered `decide` tool so runTool('decide') reaches the script for those ids. The negotiator's
 * decide() and approvalOutcome() functions should delegate to the two exported functions for them
 * (see the report), so the console and the voice worker work with no model at all.
 *
 * Two deliberate stand-ins, because they need a model: read_bill (the bill is always the
 * brake_quote fixture, whatever the photo) and second_opinion (skipped with a warn, which the
 * place_call gate allows). get_terms is skipped too.
 */
import { createHash } from 'node:crypto';
import {
  DEAL_APPROVAL_TIMEOUT_MS,
  ITEM_IDS,
  alertText,
  ackText,
  billItemId,
  callingText,
  cardOptionText,
  cdAlertText,
  cdChoiceReplyText,
  contextItem,
  dayToISODate,
  dealApprovalText,
  doneText,
  formatDate,
  formatMoney,
  formatWeekdayLong,
  formatWholeDollars,
  limitsText,
  movePaymentOptionText,
  reminderText,
  replyPrompt,
  savingsOptionText,
  statusLineText,
  weekdayOf,
  type AgentEvent,
  type Approval,
  type Bill,
  type CallOutcome,
  type Case,
  type CaseKind,
  type CaseState,
  type Change,
  type DecideResult,
  type Day,
  type ISODate,
  type ModelRole,
  type Negotiation,
  type NegotiationState,
  type Offer,
  type OfferCheck,
  type Option,
  type OptionId,
  type Plan,
  type PlanStep,
  type StepKind,
  type ToolName,
  type ToolOutput,
  type TranscriptLine,
  type VoiceApprovalResponse,
  type Weekday,
} from '@pacepay/shared';
import type { Agent } from './index';
import { assertTransition } from './machine';
import { timeoutApproval } from '../approvals';
import { currentForecast, publishForecast } from '../forecast';
import { newId } from '../ids';
import { sendText } from '../messaging/outbox';
import { defineTool, getTool, registerTool, runTool, type ToolContext, type ToolScope } from '../tools/registry';

// ---------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------

/** What the vision model would read off the repair quote photo (the demo's bill). */
const BRAKE_QUOTE = { merchant: 'Northside Auto Service', amount: 65_000, description: 'repair', confidence: 1 } as const;

/** Negotiations opened by this agent carry this prefix, so the console and the worker can route them to the script. */
const SCRIPT_PREFIX = 'neg_stub_';

export const isScriptedNegotiation = (negotiationId: string): boolean => negotiationId.startsWith(SCRIPT_PREFIX);

const d0 = (ctx: ToolContext): ISODate => ctx.store.household().day0Date;

/** Every $ amount and % in a template text, as the facts object send_message wants (the numbers came from the engine). */
function factsOf(text: string): Record<string, string> {
  const found = text.match(/[−-]?\$\s?\d[\d,]*(?:\.\d+)?|\d+(?:\.\d+)?\s?%/g) ?? [];
  return Object.fromEntries(found.map((t, i) => [`n${i + 1}`, t]));
}

/** "about $550": nearest $50 from $500 up, nearest $5 below. */
function roundAbout(cents: number): number {
  const dollars = cents / 100;
  const step = dollars >= 500 ? 50 : 5;
  return Math.round(dollars / step) * step * 100;
}

function refFor(negotiationId: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = createHash('sha1').update(negotiationId).digest();
  return Array.from({ length: 6 }, (_, i) => alphabet[bytes[i]! % alphabet.length]).join('');
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function numberToWords(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? `-${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberToWords(n % 100)}` : ''}`;
  return String(n);
}

/** "twenty five" / "thirty-five" / "a hundred" -> number, or null. */
function wordsToNumber(s: string): number | null {
  const tokens = s.toLowerCase().replace(/-/g, ' ').split(/\s+/).filter((t) => t && t !== 'and' && t !== 'a');
  if (!tokens.length) return null;
  let total = 0;
  for (const t of tokens) {
    const one = ONES.indexOf(t);
    const ten = TENS.indexOf(t);
    if (t === 'hundred') total = (total || 1) * 100;
    else if (one >= 0) total += one;
    else if (ten >= 2) total += ten * 10;
    else return null;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Cases, plans, steps
// ---------------------------------------------------------------------------

type StepSpec = [kind: StepKind, title: string, model: ModelRole];

const BILL_STEPS: StepSpec[] = [
  ['read_bill', 'Read the repair quote', 'code'],
  ['forecast', 'Check the week if paid today', 'engine'],
  ['build_options', 'Compare card, savings and moving a payment', 'engine'],
  ['send_options', 'Text Yoshua the options and a chart', 'code'],
  ['await_choice', "Wait for Yoshua's pick", 'code'],
  ['get_terms', "Pull the auto loan's terms", 'code'],
  ['plan_call', 'Plan the call to the lender', 'engine'],
  ['confirm_limits', 'Check the limits with Yoshua', 'code'],
  ['second_opinion', 'Second opinion on the call plan', 'code'],
  ['place_call', 'Call the lender', 'code'],
  ['negotiate', 'Negotiate the due date', 'code'],
  ['confirm_deal', 'Confirm the deal Yoshua approved', 'code'],
  ['post_call_summary', 'Text Yoshua the summary', 'code'],
  ['update_forecast', 'Update the forecast', 'engine'],
  ['schedule_followup', 'Remind Yoshua the night before', 'code'],
];

const CD_STEPS: StepSpec[] = [
  ['cd_options', 'Compare paying off the card with renewing', 'engine'],
  ['send_options', 'Text Yoshua the CD options', 'code'],
  ['await_choice', "Wait for Yoshua's pick", 'code'],
  ['schedule_followup', 'Text the steps the morning it matures', 'code'],
];

function openCase(ctx: ToolContext, kind: CaseKind, title: string, goal: string, steps: StepSpec[], eventId: string): Case {
  const caseId = newId('case');
  const planId = newId('plan');
  const plan: Plan = {
    id: planId,
    caseId,
    eventId,
    goal,
    author: 'template',
    writtenBy: 'code',
    steps: steps.map(([k, t, m]) => ({ id: newId('step'), kind: k, title: t, model: m, status: 'pending' as const })),
  };
  const c: Case = { id: caseId, title, state: 'NEW', planId, approvalIds: [], kind, openedAt: ctx.clock.now() };
  ctx.store.put('plans', plan);
  ctx.store.put('cases', c);
  ctx.store.setCurrentCase(caseId);
  ctx.bus.emit({ type: 'plan.created', model: 'code', caseId, planId, title: `Plan for "${title}" (scripted, no model)`, detail: { steps: plan.steps.map((s) => s.title) } });
  publishCase(ctx, caseId);
  return c;
}

function publishCase(ctx: ToolContext, caseId: string): void {
  const c = ctx.store.getItem('cases', caseId);
  if (!c) return;
  const plan = c.planId ? (ctx.store.getItem('plans', c.planId) ?? null) : null;
  const bill = c.billId ? (ctx.store.getItem('bills', c.billId) ?? null) : null;
  ctx.bus.publish({ event: 'case', data: { case: c, plan, bill } });
}

function emit(ctx: ToolContext, caseId: string | undefined, type: Parameters<ToolContext['bus']['emit']>[0]['type'], title: string, extra: { level?: 'info' | 'warn' | 'error'; detail?: unknown; model?: ModelRole; stepId?: string } = {}): void {
  ctx.bus.emit({ type, caseId, planId: caseId ? ctx.store.getItem('cases', caseId)?.planId : undefined, model: extra.model ?? 'code', title, level: extra.level, detail: extra.detail, stepId: extra.stepId });
}

function planOf(ctx: ToolContext, caseId: string): Plan | undefined {
  const c = ctx.store.getItem('cases', caseId);
  return c?.planId ? ctx.store.getItem('plans', c.planId) : undefined;
}

function setStep(ctx: ToolContext, caseId: string, kind: StepKind, status: PlanStep['status'], note?: string): PlanStep | undefined {
  const plan = planOf(ctx, caseId);
  if (!plan) return undefined;
  const idx = plan.steps.findIndex((s) => s.kind === kind && (status === 'running' ? s.status === 'pending' : s.status === 'running' || s.status === 'pending'));
  if (idx < 0) return undefined;
  const now = ctx.clock.now();
  const prev = plan.steps[idx]!;
  const next: PlanStep = {
    ...prev,
    status,
    note: note ?? prev.note,
    startedAt: prev.startedAt ?? now,
    endedAt: status === 'running' ? undefined : now,
  };
  const steps = plan.steps.map((s, i) => (i === idx ? next : s));
  ctx.store.patch('plans', plan.id, { steps });
  const type = status === 'running' ? 'step.started' : status === 'done' ? 'step.completed' : status === 'skipped' ? 'step.skipped' : 'step.failed';
  emit(ctx, caseId, type, next.title + (note ? ` (${note})` : ''), { model: next.model, stepId: next.id, level: status === 'failed' ? 'error' : undefined });
  publishCase(ctx, caseId);
  return next;
}

function begin(ctx: ToolContext, caseId: string, kind: StepKind, note?: string): void {
  setStep(ctx, caseId, kind, 'running', note);
}
function done(ctx: ToolContext, caseId: string, kind: StepKind, note?: string): void {
  setStep(ctx, caseId, kind, 'done', note);
}
function skip(ctx: ToolContext, caseId: string, kinds: StepKind[], note: string): void {
  for (const k of kinds) setStep(ctx, caseId, k, 'skipped', note);
}

/** Move the case along machine.ts's table. Bridges CALLING -> NEGOTIATING when a later state needs it. */
function moveTo(ctx: ToolContext, caseId: string, to: CaseState): Case {
  let c = ctx.store.mustGet('cases', caseId);
  if (c.state === to) return c;
  if (c.state === 'CALLING' && (to === 'AWAITING_APPROVAL' || to === 'SUMMARIZING')) c = moveTo(ctx, caseId, 'NEGOTIATING');
  assertTransition(c.state, to);
  const next = ctx.store.patch('cases', caseId, { state: to, ...(to === 'DONE' ? { closedAt: ctx.clock.now() } : {}) });
  publishCase(ctx, caseId);
  return next;
}

/** Commit changes to the store's accepted list and clear the case's baseChanges in the same update. */
function commit(ctx: ToolContext, caseId: string, changes: Change[], title: string): void {
  ctx.store.update((s) => {
    const c = s.cases[caseId];
    if (!c) return;
    s.acceptedChanges.push(...changes);
    s.cases[caseId] = { ...c, baseChanges: [], acceptedChanges: [...(c.acceptedChanges ?? []), ...changes] };
  });
  publishForecast(ctx, { caseId, title });
  publishCase(ctx, caseId);
}

/** Close a case: whatever it still holds in baseChanges (the bill paid from checking) becomes accepted. */
function finish(ctx: ToolContext, caseId: string): void {
  const c = ctx.store.mustGet('cases', caseId);
  if (c.baseChanges?.length) commit(ctx, caseId, c.baseChanges, 'Kept the bill in the forecast');
  moveTo(ctx, caseId, 'DONE');
}

function scopeOf(ctx: ToolContext, caseId: string | undefined, kind?: StepKind, extra: Partial<ToolScope> = {}): ToolScope {
  const c = caseId ? ctx.store.getItem('cases', caseId) : undefined;
  const plan = caseId ? planOf(ctx, caseId) : undefined;
  const stepId = kind ? plan?.steps.find((s) => s.kind === kind)?.id : undefined;
  return { caseId, planId: c?.planId, stepId, caller: 'orchestrator', model: 'code', ...extra };
}

/** runTool that logs a failure as a warn event and returns undefined instead of throwing. */
async function soft<N extends ToolName>(ctx: ToolContext, name: N, input: unknown, scope: ToolScope): Promise<ToolOutput<N> | undefined> {
  try {
    return await runTool(name, input, ctx, scope);
  } catch (err) {
    emit(ctx, scope.caseId, 'step.failed', `${name} failed, carrying on: ${(err as Error).message}`, { level: 'warn' });
    return undefined;
  }
}

/** Text Yoshua through send_message (facts check included); a facts or tool failure falls back to outbox.sendText. */
async function say(ctx: ToolContext, scope: ToolScope, text: string): Promise<void> {
  try {
    await runTool('send_message', { text, facts: factsOf(text) }, ctx, scope);
  } catch (err) {
    emit(ctx, scope.caseId, 'step.failed', `send_message failed (${(err as Error).message}); sent through the outbox`, { level: 'warn' });
    await sendText(ctx, text, { caseId: scope.caseId, stepId: scope.stepId, model: 'code', unprompted: scope.unprompted });
  }
}

function caseFor(ctx: ToolContext, event: { caseId?: string; approvalId?: string }): Case | null {
  if (event.caseId) return ctx.store.getItem('cases', event.caseId) ?? null;
  if (event.approvalId) {
    const a = ctx.store.getItem('approvals', event.approvalId);
    if (a?.caseId) return ctx.store.getItem('cases', a.caseId) ?? null;
  }
  return ctx.store.currentCase();
}

/** One case at a time: an old unfinished case is closed (warn) when a new one starts. */
function abandonOpenCase(ctx: ToolContext): void {
  const old = ctx.store.currentCase();
  if (!old || old.state === 'DONE') return;
  for (const id of old.approvalIds) {
    const a = ctx.store.getItem('approvals', id);
    if (a?.status === 'pending') timeoutApproval(ctx, id);
  }
  const neg = old.negotiationId ? ctx.store.getItem('negotiations', old.negotiationId) : undefined;
  if (neg && neg.state !== 'closed') saveNeg(ctx, { ...neg, state: 'closed', outcome: 'no_deal' });
  const baseChanges = old.baseChanges ?? [];
  ctx.store.update((s) => {
    const c = s.cases[old.id];
    if (!c) return;
    s.acceptedChanges.push(...baseChanges);
    s.cases[old.id] = { ...c, state: 'DONE', baseChanges: [], closedAt: ctx.clock.now() };
  });
  emit(ctx, old.id, 'step.skipped', `Closed "${old.title}" (was ${old.state}) because a new case started`, { level: 'warn' });
  publishCase(ctx, old.id);
}

// ---------------------------------------------------------------------------
// Options and the alert
// ---------------------------------------------------------------------------

const OPTION_PREFERENCE: Partial<Record<OptionId, number>> = { move_payment: 0, card: 1, savings: 2, cd_payoff_card: 0, cd_renew: 1 };

/** Fewest rule violations first, then the house order: move the payment, card, savings. */
function rankOptions(options: Option[]): Option[] {
  return [...options].sort((a, b) => a.violations.length - b.violations.length || (OPTION_PREFERENCE[a.id] ?? 9) - (OPTION_PREFERENCE[b.id] ?? 9));
}

function moveChange(o: Option): Extract<Change, { type: 'move_item' }> | undefined {
  return o.changes.find((c): c is Extract<Change, { type: 'move_item' }> => c.type === 'move_item');
}
function transferChange(o: Option): Extract<Change, { type: 'transfer' }> | undefined {
  return o.changes.find((c): c is Extract<Change, { type: 'transfer' }> => c.type === 'transfer');
}

function itemLabel(ctx: ToolContext, itemId: string): string {
  const base = itemId.split('@')[0]!;
  return (ctx.store.household().scheduled.find((s) => s.id === base)?.label ?? 'payment').toLowerCase();
}

function optionLine(ctx: ToolContext, o: Option): string {
  const h = ctx.store.household();
  if (o.id === 'move_payment') return movePaymentOptionText({ itemLabel: itemLabel(ctx, moveChange(o)?.itemId ?? ITEM_IDS.carPayment), toDay: moveChange(o)?.toDay ?? 0, day0Date: h.day0Date });
  if (o.id === 'card') return cardOptionText({ monthlyInterest: o.tradeoffs.monthlyInterest ?? 0 });
  return savingsOptionText({ amount: transferChange(o)?.amount ?? 0, savingsFloor: h.rules.savingsFloor, belowFloor: o.violations.includes('BELOW_SAVINGS_FLOOR') });
}

const PICK_REASON: Partial<Record<OptionId, string>> = {
  move_payment: 'no new debt',
  card: 'your savings stay put',
  savings: 'no new debt',
};

function replyOptionsText(n: number): string {
  return replyPrompt(n);
}

// ---------------------------------------------------------------------------
// BILL_PHOTO and BILL_CORRECTION
// ---------------------------------------------------------------------------

async function onBillPhoto(ctx: ToolContext, event: Extract<AgentEvent, { type: 'BILL_PHOTO' }>): Promise<void> {
  abandonOpenCase(ctx);
  const today = ctx.clock.today();
  const title = `The ${formatWholeDollars(BRAKE_QUOTE.amount)} repair`;
  const c = openCase(ctx, 'bill', title, `Cover the ${formatWholeDollars(BRAKE_QUOTE.amount)} repair without going below Yoshua's floor`, BILL_STEPS, event.id);
  moveTo(ctx, c.id, 'ANALYZING');

  begin(ctx, c.id, 'read_bill');
  if (!event.fixture) emit(ctx, c.id, 'step.started', 'The scripted agent cannot read photos: using the brake quote', { level: 'warn' });
  const bill: Bill = {
    id: newId('bill'),
    caseId: c.id,
    mediaId: event.mediaId,
    merchant: BRAKE_QUOTE.merchant,
    amount: BRAKE_QUOTE.amount,
    dueDay: today,
    description: BRAKE_QUOTE.description,
    confidence: BRAKE_QUOTE.confidence,
    confirmed: false,
    source: event.fixture ? 'fixture' : 'photo',
  };
  ctx.store.put('bills', bill);
  ctx.store.patch('cases', c.id, { billId: bill.id });
  done(ctx, c.id, 'read_bill', 'scripted: the brake quote');
  await analyze(ctx, c.id, true);
}

async function onBillCorrection(ctx: ToolContext, event: Extract<AgentEvent, { type: 'BILL_CORRECTION' }>): Promise<void> {
  const c = caseFor(ctx, event);
  const bill = ctx.store.getItem('bills', event.billId);
  if (!c || !bill || (c.state !== 'OPTIONS_SENT' && c.state !== 'AWAITING_CHOICE' && c.state !== 'ANALYZING')) {
    emit(ctx, c?.id, 'step.skipped', `Ignored a bill correction (case is ${c?.state ?? 'missing'})`, { level: 'warn' });
    return;
  }
  for (const id of c.approvalIds) {
    const a = ctx.store.getItem('approvals', id);
    if (a?.status === 'pending') timeoutApproval(ctx, id);
  }
  moveTo(ctx, c.id, 'ANALYZING');
  ctx.store.patch('bills', bill.id, { amount: event.amount, confirmed: true, source: 'correction' });
  emit(ctx, c.id, 'step.completed', `Bill corrected to ${formatMoney(event.amount)}`, { model: 'code' });
  await analyze(ctx, c.id, false);
}

/** The forecast, the options, the chart and the alert: the part of the case a correction re-runs. */
async function analyze(ctx: ToolContext, caseId: string, firstPass: boolean): Promise<void> {
  const h = ctx.store.household();
  const today = ctx.clock.today();
  let c = ctx.store.mustGet('cases', caseId);
  const bill = ctx.store.mustGet('bills', c.billId!);
  const billDay = bill.dueDay ?? today;
  const repair = { amount: bill.amount, day: billDay, label: bill.merchant };

  // The quote counts as paid from checking today (v2.md); the bill's payment is the add_item billItemId(bill.id).
  const pay = ctx.engine.billChange(h, repair);
  if (pay.type === 'add_item') pay.item = { ...pay.item, id: billItemId(bill.id) };
  c = ctx.store.patch('cases', caseId, { baseChanges: [pay], title: `The ${formatWholeDollars(bill.amount)} repair`, options: undefined });
  publishForecast(ctx, { caseId, title: `Counted the ${formatMoney(bill.amount)} ${bill.merchant} bill as paid from checking` });

  await say(ctx, scopeOf(ctx, caseId, 'read_bill'), ackText({ merchant: bill.merchant, amount: bill.amount, dueDay: bill.dueDay, today, day0Date: h.day0Date }));

  // Forecast
  begin(ctx, caseId, 'forecast');
  await soft(ctx, 'get_forecast', { days: 14 }, scopeOf(ctx, caseId, 'forecast', { model: 'engine' }));
  const fc = currentForecast(ctx, { days: 14 });
  const lowest = fc.lowest;
  done(ctx, caseId, 'forecast', `lowest ${formatMoney(lowest.amount)} on ${formatDate(lowest.day, h.day0Date)}`);

  const floor = h.rules.checkingFloor;
  if (lowest.amount >= floor) {
    skip(ctx, caseId, ['build_options', 'send_options', 'await_choice', 'get_terms', 'plan_call', 'confirm_limits', 'second_opinion', 'place_call', 'negotiate', 'confirm_deal', 'post_call_summary', 'update_forecast', 'schedule_followup'], 'checking stays above the floor');
    await say(ctx, scopeOf(ctx, caseId), `You're fine: checking stays above ${formatWholeDollars(floor)}. Lowest ${formatMoney(lowest.amount)} on ${formatDate(lowest.day, h.day0Date)}.`);
    finish(ctx, caseId);
    return;
  }

  // Options (the household with accepted changes applied; the bill is what buildOptions adds itself)
  begin(ctx, caseId, 'build_options');
  const hAccepted = ctx.engine.applyChanges(h, ctx.store.acceptedChanges());
  const ranked = rankOptions(ctx.engine.buildOptions(hAccepted, repair, { fromDay: today }));
  c = ctx.store.patch('cases', caseId, { options: ranked });
  done(ctx, caseId, 'build_options', ranked.map((o) => o.id).join(', '));

  // Chart, then the alert as the option_choice approval's prompt (request_approval texts it)
  begin(ctx, caseId, 'send_options');
  await soft(ctx, 'send_chart', { kind: 'week' }, scopeOf(ctx, caseId, 'send_options'));

  const causeDays = lowest.causeItemIds
    .map((id) => {
      const day = fc.days.find((d) => d.day <= lowest.day && d.items.some((i) => i.itemId === id));
      const item = day?.items.find((i) => i.itemId === id);
      return day && item ? { label: item.label.toLowerCase(), day: day.day } : null;
    })
    .filter((x): x is { label: string; day: Day } => !!x);
  const payday = fc.days.find((d) => d.day > lowest.day && d.items.some((i) => i.itemId === ITEM_IDS.paycheck));
  const context = [...causeDays, ...(payday ? [{ label: 'paycheck', day: payday.day }] : [])]
    .sort((a, b) => a.day - b.day)
    .map((x) => contextItem(x.label, x.day, { day0Date: h.day0Date }));
  const noun = bill.description.includes('repair') ? 'the repair' : 'the bill';
  const prompt = alertText({
    lowest,
    condition: `if you pay ${noun} ${billDay === today ? 'today' : `on ${weekdayOf(billDay, h.day0Date)}`}`,
    context,
    options: ranked.map((o) => optionLine(ctx, o)),
    pickReason: PICK_REASON[ranked[0]!.id] ?? 'it costs you the least',
    day0Date: h.day0Date,
  });
  const optionIds = ranked.map((o) => o.id);
  await runTool('request_approval', { kind: 'option_choice', prompt, choices: ranked.map((_, i) => String(i + 1)), optionIds }, ctx, scopeOf(ctx, caseId, 'send_options'));
  done(ctx, caseId, 'send_options');
  moveTo(ctx, caseId, 'OPTIONS_SENT');
  moveTo(ctx, caseId, 'AWAITING_CHOICE');
  begin(ctx, caseId, 'await_choice');
  void firstPass;
}

// ---------------------------------------------------------------------------
// CHOICE_REPLY
// ---------------------------------------------------------------------------

async function onChoice(ctx: ToolContext, event: Extract<AgentEvent, { type: 'CHOICE_REPLY' }>): Promise<void> {
  const c = caseFor(ctx, event);
  if (!c) return void emit(ctx, undefined, 'step.skipped', 'Ignored a choice: no open case', { level: 'warn' });
  const opt = c.options?.find((o) => o.id === event.optionId);

  // A late pick after "no" to the call (case already DONE): the next-best options approval is still answerable.
  if (c.state === 'DONE' && c.approvalIds.includes(event.approvalId) && opt && (opt.id === 'card' || opt.id === 'savings')) {
    await advise(ctx, c, opt, true);
    return;
  }
  if (c.state !== 'AWAITING_CHOICE') {
    return void emit(ctx, c.id, 'step.skipped', `Ignored choice ${event.choice}: case is ${c.state}`, { level: 'warn' });
  }
  if (!opt) return void emit(ctx, c.id, 'step.failed', `Choice ${event.choice} (${event.optionId}) is not one of the case's options`, { level: 'error' });

  ctx.store.patch('cases', c.id, { chosenOption: opt.id });
  done(ctx, c.id, 'await_choice', `picked ${opt.id}`);

  if (c.kind === 'cd_maturing') return cdChoice(ctx, c.id, opt);
  if (opt.id === 'move_payment') return prepareCall(ctx, c.id, opt);
  return advise(ctx, c, opt, false);
}

/** Card or savings: PacePay never moves money, so it texts how and closes the case. */
async function advise(ctx: ToolContext, c: Case, opt: Option, late: boolean): Promise<void> {
  const h = ctx.store.household();
  const bill = ctx.store.mustGet('bills', c.billId!);
  if (!late) {
    skip(ctx, c.id, ['get_terms', 'plan_call', 'confirm_limits', 'second_opinion', 'place_call', 'negotiate', 'confirm_deal', 'post_call_summary', 'update_forecast', 'schedule_followup'], 'you chose to handle it yourself');
    moveTo(ctx, c.id, 'ADVISED');
  } else {
    // Swap the "bill paid from checking" we kept for the option's own changes.
    const billId = billItemId(bill.id);
    ctx.store.setAcceptedChanges(ctx.store.acceptedChanges().filter((ch) => !(ch.type === 'add_item' && ch.item.id === billId)));
  }
  ctx.store.patch('cases', c.id, { chosenOption: opt.id });
  const text =
    opt.id === 'card'
      ? `Here's how: put the ${formatMoney(bill.amount)} on your card today. It costs about ${formatWholeDollars(opt.tradeoffs.monthlyInterest ?? 0)}/mo in interest until you pay it off. I don't move money myself.`
      : `Here's how: move ${formatWholeDollars(transferChange(opt)?.amount ?? 0)} from savings to checking today, then pay the ${formatMoney(bill.amount)}. Savings will be ${formatWholeDollars(opt.tradeoffs.savingsAfter ?? 0)}${opt.violations.includes('BELOW_SAVINGS_FLOOR') ? `, under your ${formatWholeDollars(h.rules.savingsFloor)} floor` : ''}. I don't move money myself.`;
  await say(ctx, scopeOf(ctx, c.id), text);
  if (!late) {
    commit(ctx, c.id, opt.changes, `Counted "${opt.label}" in the forecast`);
    moveTo(ctx, c.id, 'DONE');
  } else {
    ctx.store.addAcceptedChanges(opt.changes);
    publishForecast(ctx, { caseId: c.id, title: `Counted "${opt.label}" in the forecast` });
    publishCase(ctx, c.id);
  }
}

/** The call option: plan it, open the negotiation, ask for the limits. */
async function prepareCall(ctx: ToolContext, caseId: string, opt: Option): Promise<void> {
  const h = ctx.store.household();
  const today = ctx.clock.today();
  moveTo(ctx, caseId, 'PREPARING_CALL');
  skip(ctx, caseId, ['get_terms'], 'scripted agent has no terms lookup');
  begin(ctx, caseId, 'plan_call');
  const itemId = moveChange(opt)?.itemId ?? ITEM_IDS.carPayment;
  const item = h.scheduled.find((s) => s.id === itemId);
  const targets = ctx.engine.planCallTargets(h, itemId, { baseChanges: ctx.store.forecastChanges(), fromDay: today });
  if (targets.targetDay < 0 || !item) {
    done(ctx, caseId, 'plan_call', 'no day works');
    await nextBest(ctx, caseId, 'No day works for moving that payment, so I would not call.');
    return;
  }
  const label = item.label.toLowerCase();
  const neg: Negotiation = {
    id: `${SCRIPT_PREFIX}${newId('neg').slice(4)}`,
    caseId,
    counterpartyId: item.counterpartyId ?? 'auto_lender',
    itemId,
    channel: 'voice',
    callPlan: {
      goal: `Move the ${label} to ${formatWeekdayLong(targets.targetDay, h.day0Date)} or a day after payday`,
      targetDay: targets.targetDay,
      acceptableDays: targets.acceptableDays,
      feeLimit: targets.feeLimit,
      openingAsk: `Ask to move the ${label} to ${formatWeekdayLong(targets.targetDay, h.day0Date)} with no fee`,
      walkAway: 'Stop when the lender refuses or asks to verify the account holder',
      fallbackText: 'Text Yoshua the next-best options',
    },
    offers: [],
    checks: [],
    state: 'opening',
    transcript: [],
  };
  saveNeg(ctx, neg);
  ctx.store.patch('cases', caseId, { negotiationId: neg.id });
  done(ctx, caseId, 'plan_call', `${formatDate(targets.targetDay, h.day0Date)}, fee limit ${formatWholeDollars(targets.feeLimit)}`);

  moveTo(ctx, caseId, 'AWAITING_LIMITS');
  begin(ctx, caseId, 'confirm_limits');
  await runTool(
    'request_approval',
    { kind: 'call_limits', prompt: limitsText({ toDay: targets.targetDay, feeLimit: targets.feeLimit, day0Date: h.day0Date }), choices: ['yes', 'no'] },
    ctx,
    scopeOf(ctx, caseId, 'confirm_limits'),
  );
}

/** "No" to the limits, or no workable day: text the options that are left and close the case. */
async function nextBest(ctx: ToolContext, caseId: string, intro: string): Promise<void> {
  const c = ctx.store.mustGet('cases', caseId);
  skip(ctx, caseId, ['confirm_limits', 'second_opinion', 'place_call', 'negotiate', 'confirm_deal', 'post_call_summary', 'update_forecast', 'schedule_followup'], 'no call');
  if (c.state === 'PREPARING_CALL' || c.state === 'AWAITING_CHOICE' || c.state === 'AWAITING_LIMITS') moveTo(ctx, caseId, 'ADVISED');
  const rest = (c.options ?? []).filter((o) => o.id !== 'move_payment');
  if (rest.length) {
    const body = rest.map((o, i) => `${i + 1}. ${optionLine(ctx, o)}`).join('\n');
    await runTool(
      'request_approval',
      { kind: 'option_choice', prompt: `${intro} Your other options:\n${body}\n${replyOptionsText(rest.length)} I don't move money myself.`, choices: rest.map((_, i) => String(i + 1)), optionIds: rest.map((o) => o.id) },
      ctx,
      scopeOf(ctx, caseId),
    );
  } else {
    await say(ctx, scopeOf(ctx, caseId), `${intro} Nothing changed.`);
  }
  finish(ctx, caseId);
}

// ---------------------------------------------------------------------------
// APPROVAL_REPLY, calls
// ---------------------------------------------------------------------------

async function onApproval(ctx: ToolContext, event: Extract<AgentEvent, { type: 'APPROVAL_REPLY' }>): Promise<void> {
  const a = ctx.store.getItem('approvals', event.approvalId);
  const c = caseFor(ctx, event);
  if (!a || !c) return void emit(ctx, c?.id, 'step.skipped', 'Ignored a reply: approval or case missing', { level: 'warn' });
  if (a.kind === 'call_limits') return onLimits(ctx, c, event.answer);
  if (a.kind === 'deal') return onDeal(ctx, c, a);
  emit(ctx, c.id, 'step.skipped', `Nothing to do for a ${a.kind} reply`, { level: 'warn' });
}

async function onLimits(ctx: ToolContext, c: Case, answer: 'yes' | 'no'): Promise<void> {
  if (c.state !== 'AWAITING_LIMITS') return void emit(ctx, c.id, 'step.skipped', `Ignored the limits reply: case is ${c.state}`, { level: 'warn' });
  if (answer === 'no') {
    done(ctx, c.id, 'confirm_limits', 'Yoshua said no');
    await nextBest(ctx, c.id, "No problem, I won't call.");
    return;
  }
  done(ctx, c.id, 'confirm_limits', 'Yoshua approved');
  moveTo(ctx, c.id, 'REVIEWING');

  // The second opinion needs Claude: skipped with a warn, which the place_call gate allows.
  const at = ctx.clock.now();
  ctx.store.patch('cases', c.id, { review: { verdict: 'skipped', issues: [], at } });
  setStep(ctx, c.id, 'second_opinion', 'skipped', 'scripted agent has no Claude');
  emit(ctx, c.id, 'review.result', 'Second opinion skipped: the scripted agent has no Claude', { level: 'warn' });

  const neg = ctx.store.mustGet('negotiations', c.negotiationId!);
  await say(ctx, scopeOf(ctx, c.id, 'place_call'), callingText());
  begin(ctx, c.id, 'place_call');
  let callId: string | undefined;
  let failed = false;
  try {
    const out = await runTool('place_call', { negotiationId: neg.id }, ctx, scopeOf(ctx, c.id, 'place_call'));
    callId = out.callId;
    failed = ctx.store.getItem('calls', out.callId)?.status === 'failed';
  } catch (err) {
    failed = true;
    emit(ctx, c.id, 'call.failed', `Could not place the call: ${(err as Error).message}`, { level: 'error' });
  }
  moveTo(ctx, c.id, 'CALLING');
  if (failed) {
    setStep(ctx, c.id, 'place_call', 'skipped', 'the call did not connect, so by text');
    // place_call already enqueued CALL_FAILED when it got as far as dialing; otherwise do it here.
    if (!callId) await toTextNegotiation(ctx, c.id, 'could not place the call');
    return;
  }
  done(ctx, c.id, 'place_call', 'the lender answered');
  moveTo(ctx, c.id, 'NEGOTIATING');
  begin(ctx, c.id, 'negotiate');
}

async function onCallFailed(ctx: ToolContext, event: Extract<AgentEvent, { type: 'CALL_FAILED' }>): Promise<void> {
  const neg = event.negotiationId ? ctx.store.getItem('negotiations', event.negotiationId) : undefined;
  const c = neg ? ctx.store.getItem('cases', neg.caseId) : ctx.store.currentCase();
  if (!c || (c.state !== 'CALLING' && c.state !== 'NEGOTIATING' && c.state !== 'AWAITING_APPROVAL')) {
    return void emit(ctx, c?.id, 'step.skipped', `Ignored CALL_FAILED (${event.reason}): case is ${c?.state ?? 'missing'}`, { level: 'warn' });
  }
  if (c.state === 'CALLING') setStep(ctx, c.id, 'place_call', 'skipped', `the call did not connect (${event.reason}), so by text`);
  await toTextNegotiation(ctx, c.id, event.reason);
}

/** The call failed: the lender console takes over, with the same script. */
async function toTextNegotiation(ctx: ToolContext, caseId: string, reason: string): Promise<void> {
  const c = ctx.store.mustGet('cases', caseId);
  const neg = c.negotiationId ? ctx.store.getItem('negotiations', c.negotiationId) : undefined;
  if (c.state === 'CALLING' || c.state === 'NEGOTIATING' || c.state === 'AWAITING_APPROVAL') moveTo(ctx, caseId, 'TEXT_NEGOTIATION');
  if (neg && neg.state !== 'closed') {
    const next: Negotiation = { ...neg, channel: 'text' };
    saveNeg(ctx, next);
    // A pending deal approval stays pending; otherwise PacePay opens the conversation.
    if (neg.state !== 'awaiting_approval' && !(neg.transcript ?? []).some((l) => l.speaker === 'pacepay')) {
      pacepayLine(ctx, neg.id, openingLine(ctx, neg.id), neg.offers.length ? neg.state : 'listening');
    }
  }
  begin(ctx, caseId, 'negotiate', 'by text');
  emit(ctx, caseId, 'step.started', `Switched to the lender console (${reason})`, { level: 'warn' });
}

async function onDeal(ctx: ToolContext, c: Case, a: Approval): Promise<void> {
  const negId = a.negotiationId ?? c.negotiationId;
  if (!negId) return;
  scriptedApprovalOutcome(ctx, negId);
  await settle(ctx, c.id);
}

/** After a deal approval resolves: approved -> CONFIRMING (changes committed), timeout -> HOLD_REQUESTED. */
async function settle(ctx: ToolContext, caseId: string): Promise<void> {
  const c = ctx.store.mustGet('cases', caseId);
  const neg = c.negotiationId ? ctx.store.getItem('negotiations', c.negotiationId) : undefined;
  if (!neg) return;
  if (c.state === 'NEGOTIATING' || c.state === 'TEXT_NEGOTIATION' || c.state === 'CALLING') {
    // The approval was requested through decide (which moves to AWAITING_APPROVAL); a stray resolve before that is a no-op.
    if (neg.outcome === 'deal' || neg.outcome === 'approval_timeout') moveTo(ctx, caseId, 'AWAITING_APPROVAL');
    else return;
  }
  const cur = ctx.store.mustGet('cases', caseId);
  if (cur.state !== 'AWAITING_APPROVAL') return;
  if (neg.outcome === 'deal') {
    const offer = acceptedOffer(neg);
    if (!offer) return;
    done(ctx, caseId, 'negotiate', `${formatDate(offer.newDay, d0(ctx))}, ${offer.fee === 0 ? 'no fee' : formatMoney(offer.fee)}`);
    begin(ctx, caseId, 'confirm_deal');
    const changes = [...(cur.baseChanges ?? []), ...ctx.engine.offerChanges(ctx.store.household(), { itemId: offer.itemId, newDay: offer.newDay, fee: offer.fee })];
    moveTo(ctx, caseId, 'CONFIRMING');
    commit(ctx, caseId, changes, `Moved the ${itemLabel(ctx, offer.itemId)} to ${formatDate(offer.newDay, d0(ctx))}`);
    done(ctx, caseId, 'confirm_deal', 'Yoshua approved');
  } else if (neg.outcome === 'approval_timeout') {
    moveTo(ctx, caseId, 'HOLD_REQUESTED');
  }
}

async function onApprovalTimeout(ctx: ToolContext, event: Extract<AgentEvent, { type: 'APPROVAL_TIMEOUT' }>): Promise<void> {
  const a = ctx.store.getItem('approvals', event.approvalId);
  if (!a) return;
  const c = caseFor(ctx, event);
  if (event.reminder) {
    if (a.status !== 'pending') return;
    const nudge = a.kind === 'option_choice' ? `Still here when you're ready. ${replyPrompt(a.choices.length)}` : 'Still waiting on your answer. YES or NO';
    await say(ctx, scopeOf(ctx, c?.id, undefined, { unprompted: true }), nudge);
    return;
  }
  if (a.kind !== 'deal' || !c) return;
  const negId = a.negotiationId ?? c.negotiationId;
  if (!negId) return;
  scriptedApprovalOutcome(ctx, negId);
  await settle(ctx, c.id);
}

async function onCallEnded(ctx: ToolContext, event: Extract<AgentEvent, { type: 'CALL_ENDED' }>): Promise<void> {
  const neg = event.negotiationId ? ctx.store.getItem('negotiations', event.negotiationId) : undefined;
  const callCase = ctx.store.list('calls').find((x) => x.id === event.callId)?.negotiationId;
  const negotiation = neg ?? (callCase ? ctx.store.getItem('negotiations', callCase) : undefined);
  const c = negotiation ? ctx.store.getItem('cases', negotiation.caseId) : ctx.store.currentCase();
  if (!c || !negotiation || c.state === 'DONE' || c.state === 'SUMMARIZING') {
    return void emit(ctx, c?.id, 'step.skipped', `Ignored CALL_ENDED: case is ${c?.state ?? 'missing'}`, { level: 'info' });
  }
  if (negotiation.state !== 'closed') {
    // The call dropped before the script closed it: use the deal approval if Yoshua already answered it.
    const dealApproval = latestDealApproval(ctx, negotiation.id);
    if (dealApproval && dealApproval.status !== 'pending') scriptedApprovalOutcome(ctx, negotiation.id);
    else closeNegotiation(ctx, negotiation.id, 'no_deal');
  }
  await settle(ctx, c.id);

  let cur = ctx.store.mustGet('cases', c.id);
  if (cur.state === 'CALLING') cur = moveTo(ctx, c.id, 'TEXT_NEGOTIATION');
  moveTo(ctx, c.id, 'SUMMARIZING');
  const n = ctx.store.mustGet('negotiations', negotiation.id);
  const h = ctx.store.household();
  const label = itemLabel(ctx, n.itemId);
  const offer = acceptedOffer(n);
  const ref = n.referenceNumber ?? refFor(n.id);
  if (n.callId) ctx.store.patch('calls', n.callId, { outcome: n.outcome, referenceNumber: n.outcome ? ref : undefined });
  begin(ctx, c.id, 'post_call_summary');

  if (n.outcome === 'deal' && offer) {
    await say(ctx, scopeOf(ctx, c.id, 'post_call_summary'), doneText({ itemLabel: label, toDay: offer.newDay, fee: offer.fee, reference: ref, day0Date: h.day0Date }));
    done(ctx, c.id, 'post_call_summary');
    begin(ctx, c.id, 'update_forecast');
    done(ctx, c.id, 'update_forecast', 'the moved payment is in the forecast');
    // The reminder the night before, from the forecast with the deal applied.
    begin(ctx, c.id, 'schedule_followup');
    const postDay = ctx.engine.postingDay(h, offer.newDay);
    const fc = currentForecast(ctx, { days: 30 });
    const fd = fc.days.find((x) => x.day === postDay);
    const item = h.scheduled.find((s) => s.id === offer.itemId.split('@')[0]);
    const text = reminderText({ itemLabel: label, amount: Math.abs(item?.amount ?? 0), fee: offer.fee, when: 'tomorrow', balanceAfter: fd?.close ?? 0 });
    await soft(ctx, 'schedule_followup', { atDay: Math.max(ctx.clock.today(), postDay - 1), text }, scopeOf(ctx, c.id, 'schedule_followup'));
    done(ctx, c.id, 'schedule_followup', `the night before, ${formatDate(postDay - 1, h.day0Date)}`);
    finish(ctx, c.id);
    return;
  }

  done(ctx, c.id, 'negotiate', n.outcome ?? 'no deal');
  skip(ctx, c.id, ['confirm_deal', 'update_forecast', 'schedule_followup'], 'nothing changed');
  if (n.outcome === 'approval_timeout' && offer) {
    await say(ctx, scopeOf(ctx, c.id, 'post_call_summary'), `I didn't hear back in time, so I asked your lender to hold ${formatDate(offer.newDay, h.day0Date)} ${offer.fee === 0 ? 'with no fee' : `for ${formatMoney(offer.fee)}`}. Ref ${ref}.`);
    done(ctx, c.id, 'post_call_summary');
    finish(ctx, c.id);
    return;
  }
  done(ctx, c.id, 'post_call_summary');
  const intro =
    n.outcome === 'handoff_verification'
      ? `Your lender needs to verify the account holder, so I stopped there. Ref ${ref}.`
      : dealDeclined(ctx, n.id)
        ? 'Okay, I told them no deal. Nothing changed.'
        : "They couldn't move it to a day that works, so nothing changed.";
  await nextBest(ctx, c.id, intro);
}

/** The offer being settled: the latest one the lender confirmed (the deal approval is requested right after it passes). */
function acceptedOffer(neg: Negotiation): Offer | undefined {
  return [...neg.offers].reverse().find((o) => o.readBackConfirmed) ?? neg.offers[neg.offers.length - 1];
}

function latestDealApproval(ctx: ToolContext, negotiationId: string): Approval | undefined {
  return ctx.store
    .list('approvals')
    .filter((a) => a.kind === 'deal' && a.negotiationId === negotiationId)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
}

function dealDeclined(ctx: ToolContext, negotiationId: string): boolean {
  return latestDealApproval(ctx, negotiationId)?.status === 'declined';
}

// ---------------------------------------------------------------------------
// The scripted negotiation
// ---------------------------------------------------------------------------

function saveNeg(ctx: ToolContext, neg: Negotiation): Negotiation {
  const saved = ctx.store.put('negotiations', neg);
  ctx.bus.publish({ event: 'negotiation', data: saved });
  return saved;
}

/** PacePay says `text`; recorded in the negotiation transcript (and the feed, for text mode). */
function pacepayLine(ctx: ToolContext, negId: string, text: string, state?: NegotiationState): Negotiation {
  const neg = ctx.store.mustGet('negotiations', negId);
  const line: TranscriptLine = { at: ctx.clock.now(), speaker: 'pacepay', text };
  if (neg.channel === 'text') emit(ctx, neg.caseId, 'call.transcript', `PacePay: "${text}"`, { detail: { speaker: 'pacepay', negotiationId: negId } });
  return saveNeg(ctx, { ...neg, transcript: [...(neg.transcript ?? []), line], state: state ?? neg.state });
}

function lenderLine(ctx: ToolContext, negId: string, text: string): Negotiation {
  const neg = ctx.store.mustGet('negotiations', negId);
  const line: TranscriptLine = { at: ctx.clock.now(), speaker: 'counterparty', text };
  if (neg.channel === 'text') emit(ctx, neg.caseId, 'call.transcript', `Lender: "${text}"`, { detail: { speaker: 'counterparty', negotiationId: negId } });
  return saveNeg(ctx, { ...neg, transcript: [...(neg.transcript ?? []), line] });
}

/** Close the negotiation once and tell the agent (CALL_ENDED) so the case summarizes. */
function closeNegotiation(ctx: ToolContext, negId: string, outcome: CallOutcome, referenceNumber?: string): Negotiation {
  const neg = ctx.store.mustGet('negotiations', negId);
  if (neg.state === 'closed' && neg.outcome) return neg;
  const saved = saveNeg(ctx, { ...neg, state: 'closed', outcome, referenceNumber: referenceNumber ?? neg.referenceNumber ?? (outcome === 'no_deal' ? undefined : refFor(neg.id)) });
  ctx.enqueue({ id: newId('evt'), at: ctx.clock.now(), type: 'CALL_ENDED', callId: saved.callId ?? saved.id, negotiationId: saved.id });
  return saved;
}

export function openingLine(ctx: ToolContext, negotiationId: string): string {
  const neg = ctx.store.mustGet('negotiations', negotiationId);
  const h = ctx.store.household();
  const account = h.accounts.find((a) => a.kind === 'auto_loan' && neg.itemId.startsWith(ITEM_IDS.carPayment));
  const label = itemLabel(ctx, neg.itemId);
  // SPEC §8.3: say it's an AI assistant acting with Yoshua's permission, and that this is transcribed.
  return `Hi, I'm PacePay, an AI assistant contacting you on behalf of Yoshua, with Yoshua's permission, about the ${label}${account?.reference ? ` on the account ${account.reference}` : ''}. This conversation is transcribed. Could you move it to ${formatWeekdayLong(neg.callPlan.targetDay, h.day0Date)} with no fee?`;
}

// --- parsing the lender's words ---

const WEEKDAY_NAMES: [RegExp, Weekday][] = [
  [/\b(monday|mon)\b/, 'Mon'],
  [/\b(tuesday|tues|tue)\b/, 'Tue'],
  [/\b(wednesday|wed)\b/, 'Wed'],
  [/\b(thursday|thurs|thur|thu)\b/, 'Thu'],
  [/\b(friday|fri)\b/, 'Fri'],
  [/\b(saturday|sat)\b/, 'Sat'],
  [/\b(sunday|sun)\b/, 'Sun'],
];

function parseDay(ctx: ToolContext, lower: string): Day | null {
  const today = ctx.clock.today();
  const day0 = d0(ctx);
  if (/\btomorrow\b/.test(lower)) return today + 1;
  if (/\btoday\b/.test(lower)) return today;
  for (const [re, wd] of WEEKDAY_NAMES) {
    if (!re.test(lower)) continue;
    for (let d = today + 1; d <= today + 7; d += 1) if (weekdayOf(d, day0) === wd) return d;
  }
  const ordinal = /\b(\d{1,2})(?:st|nd|rd|th)\b/.exec(lower);
  if (ordinal) {
    const dom = Number(ordinal[1]);
    for (let d = today + 1; d <= today + 31; d += 1) if (Number(dayToISODate(d, day0).slice(8, 10)) === dom) return d;
  }
  return null;
}

/** Cents, 0 for "no fee", or null when no amount was said. */
function parseFee(lower: string): number | null | 'unspecified' {
  if (/\b(no fee|no charge|free|waive[ds]?|waiving|without (a |any )?fee|zero)\b/.test(lower)) return 0;
  const dollars = /\$\s?(\d+(?:\.\d{1,2})?)/.exec(lower) ?? /\b(\d+(?:\.\d{1,2})?)\s*(?:dollars?|bucks|usd)\b/.exec(lower);
  if (dollars) return Math.round(Number(dollars[1]) * 100);
  const words = /\b((?:(?:a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)[\s-]*)+)(?:dollars?|bucks)\b/.exec(lower);
  if (words) {
    const n = wordsToNumber(words[1]!);
    if (n !== null) return n * 100;
  }
  if (/\bfee\b|\bcharge\b/.test(lower)) return 'unspecified';
  return null;
}

const CONFIRM = /^(yes|yeah|yep|yup|correct|right|exactly|sure|ok|okay|affirmative|that works|that is right|thats right|thats correct|uh huh|mm hmm)\b/;
const DENY = /^(no|nope|nah|not quite|wrong|incorrect|thats not right|that is not right)\b/;
const VERIFY = /(verif|account holder|account owner|identity|prove|security question|date of birth|last four|social security|\bssn\b|\bpin\b|speak (to|with) (him|yoshua)|put (him|yoshua) on)/;
const REFUSAL = /\b(no|nope|can'?t|cannot|won'?t|unable|not able|not possible|no way|against (the )?policy|refuse|impossible|not allowed|don'?t do that|we don'?t)\b/;
const HOLD = /\b(hold on|one moment|just a moment|one sec|give me a (moment|second|minute)|bear with me)\b/;

interface Script {
  counters: number;
  last: 'none' | 'waiver' | 'day';
}
const scripts = new Map<string, Script>();
const scriptOf = (negId: string): Script => {
  let s = scripts.get(negId);
  if (!s) scripts.set(negId, (s = { counters: 0, last: 'none' }));
  return s;
};

function normalize(text: string): string {
  return text.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9$.'\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function spokenFee(fee: number): string {
  if (fee === 0) return 'with no fee';
  if (fee % 100 === 0 && fee < 100_000) return `with a ${numberToWords(fee / 100)}-dollar fee`;
  return `with a ${formatMoney(fee)} fee`;
}

/**
 * SPEC §5.6 decide(), scripted: no model. New offer -> read-back; confirmed read-back -> check_offer;
 * pass -> deal approval (60 s) and hold; fail -> a counter from the call plan (a waiver ask when
 * the fee is the only problem), never a reason or a limit; verification -> reference number and
 * hand-off; refusal -> thanks and no_deal. Every line lands in negotiation.transcript.
 */
export async function scriptedDecide(ctx: ToolContext, negotiationId: string, utterance: string): Promise<DecideResult> {
  const h = ctx.store.household();
  const lower = normalize(utterance);
  let neg = lenderLine(ctx, negotiationId, utterance);
  const script = scriptOf(negotiationId);
  const reply = (say: string, next: DecideResult['next'], state: NegotiationState, patch: Partial<Negotiation> = {}): DecideResult => {
    const cur = ctx.store.mustGet('negotiations', negotiationId);
    saveNeg(ctx, { ...cur, ...patch });
    pacepayLine(ctx, negotiationId, say, state);
    return { say, next, state };
  };
  const end = (say: string, outcome: CallOutcome, ref?: string): DecideResult => {
    const r = reply(say, 'end_call', 'closed');
    closeNegotiation(ctx, negotiationId, outcome, ref);
    return r;
  };

  if (neg.state === 'closed') return { say: "Thanks, we're all set. Goodbye.", next: 'end_call', state: 'closed' };

  // Waiting on Yoshua: hold the lender, or deliver the answer if it just arrived.
  if (neg.state === 'awaiting_approval') {
    const out = scriptedApprovalOutcome(ctx, negotiationId);
    const state = ctx.store.mustGet('negotiations', negotiationId).state;
    if (out.status === 'pending') return reply('Thanks for holding, I am still checking with Yoshua.', 'await_approval', 'awaiting_approval');
    return { say: out.say ?? 'Thank you. Goodbye.', next: out.next ?? 'end_call', state };
  }

  if (HOLD.test(lower)) return reply('Of course, take your time.', 'listen', neg.state === 'opening' ? 'listening' : neg.state);

  if (VERIFY.test(lower)) {
    return end('I understand. Could I get a reference number for this call? Yoshua will follow up with you directly. Thank you.', 'handoff_verification', refFor(negotiationId));
  }

  const pending = neg.pendingOfferId ? neg.offers.find((o) => o.id === neg.pendingOfferId) : undefined;
  const dayWord = parseDay(ctx, lower);
  const feeWord = parseFee(lower);

  // A confirmation of the read-back -> check_offer.
  if (pending && CONFIRM.test(lower) && dayWord === null) {
    return confirmPending(ctx, neg, pending, script, reply, end);
  }

  // A new or amended offer.
  if (dayWord !== null || (typeof feeWord === 'number' && !CONFIRM.test(lower)) || (pending && feeWord === 'unspecified')) {
    const last = neg.offers[neg.offers.length - 1];
    const day = dayWord ?? pending?.newDay ?? last?.newDay;
    if (day === undefined || day === null) {
      return reply('Which day would that be, and is there a fee?', 'listen', 'listening');
    }
    if (feeWord === 'unspecified') {
      return reply(`How much would the fee be for ${formatWeekdayLong(day, h.day0Date)}?`, 'listen', 'listening');
    }
    const fee = typeof feeWord === 'number' ? feeWord : dayWord !== null ? 0 : (pending?.fee ?? last?.fee ?? 0);
    const offer: Offer = { id: newId('offer'), negotiationId, itemId: neg.itemId, newDay: day, fee, heard: utterance, readBackConfirmed: false };
    emit(ctx, neg.caseId, 'offer.heard', `Lender offered ${formatDate(day, h.day0Date)} ${fee === 0 ? 'with no fee' : `for ${formatMoney(fee)}`}`, { detail: { heard: utterance } });
    const say = `So that's ${formatWeekdayLong(day, h.day0Date)}, ${spokenFee(fee)}?`;
    const r = reply(say, 'listen', 'reading_back', { offers: [...neg.offers, offer], pendingOfferId: offer.id });
    emit(ctx, neg.caseId, 'offer.read_back', `Read back: "${say}"`);
    return r;
  }

  // Denied the read-back.
  if (pending && DENY.test(lower)) {
    return reply('Sorry about that. What day and fee did you have in mind?', 'listen', 'listening', { pendingOfferId: undefined });
  }

  // Asked something.
  if (/\?|^(who|what|why|how|where|when|can you|could you tell)\b/.test(lower)) {
    const account = h.accounts.find((a) => a.kind === 'auto_loan');
    return reply(
      `This is PacePay, an assistant calling for Yoshua about the car loan${account?.reference ? ` ${account.reference}` : ''}. Could we move the payment to ${formatWeekdayLong(neg.callPlan.targetDay, h.day0Date)} with no fee?`,
      'listen',
      neg.state === 'opening' ? 'listening' : neg.state,
    );
  }

  // A refusal.
  if (REFUSAL.test(lower)) {
    if (neg.state === 'countering' && script.last === 'waiver' && script.counters < 3) {
      script.counters += 1;
      script.last = 'day';
      const day = neg.callPlan.targetDay;
      return reply(`Understood. Would ${formatWeekdayLong(day, h.day0Date)} work instead?`, 'listen', 'countering');
    }
    return end('Understood. Thank you for your time. Goodbye.', 'no_deal');
  }

  // Vague ("early next week") or a greeting.
  if (neg.state === 'opening' || neg.offers.length === 0) {
    return reply(openingLine(ctx, negotiationId), 'listen', 'listening');
  }
  return reply('Could you give me a specific day, and the fee if there is one?', 'listen', 'listening');
}

async function confirmPending(
  ctx: ToolContext,
  neg: Negotiation,
  pending: Offer,
  script: Script,
  reply: (say: string, next: DecideResult['next'], state: NegotiationState, patch?: Partial<Negotiation>) => DecideResult,
  end: (say: string, outcome: CallOutcome, ref?: string) => DecideResult,
): Promise<DecideResult> {
  const h = ctx.store.household();
  const scope = scopeOf(ctx, neg.caseId, undefined, { caller: 'negotiator', model: 'engine' });
  const confirmed: Offer = { ...pending, readBackConfirmed: true };
  emit(ctx, neg.caseId, 'offer.confirmed', `Lender confirmed the read-back: ${formatDate(pending.newDay, h.day0Date)}`);
  const check: OfferCheck = await runTool('check_offer', { itemId: pending.itemId, newDay: pending.newDay, fee: pending.fee }, ctx, scope);
  const fresh = ctx.store.mustGet('negotiations', neg.id);
  const withCheck: Partial<Negotiation> = {
    offers: fresh.offers.map((o) => (o.id === pending.id ? confirmed : o)),
    checks: [...(fresh.checks ?? []), { ...check, offerId: pending.id }],
    pendingOfferId: undefined,
  };

  if (check.pass) {
    const c = ctx.store.mustGet('cases', neg.caseId);
    moveTo(ctx, c.id, 'AWAITING_APPROVAL');
    const say = 'Let me confirm that with Yoshua.';
    const r = reply(say, 'await_approval', 'awaiting_approval', withCheck);
    await runTool(
      'request_approval',
      {
        kind: 'deal',
        prompt: dealApprovalText({ toDay: pending.newDay, fee: pending.fee, checkingFloor: h.rules.checkingFloor, day0Date: h.day0Date }),
        choices: ['yes', 'no'],
        timeoutMs: DEAL_APPROVAL_TIMEOUT_MS,
        callId: fresh.callId,
        negotiationId: neg.id,
      },
      ctx,
      scopeOf(ctx, c.id, 'confirm_deal', { caller: 'negotiator' }),
    );
    begin(ctx, c.id, 'confirm_deal');
    return r;
  }

  // Failed: counter from the call plan, never a reason or a limit.
  script.counters += 1;
  const onlyFee = check.affordable && !check.withinLimits && check.reasons.includes('FEE_OVER_LIMIT') && !check.reasons.includes('PAYDAY_SAME_DAY');
  if (script.counters > 4) {
    saveNeg(ctx, { ...ctx.store.mustGet('negotiations', neg.id), ...withCheck });
    return end("I'm sorry, I don't think we can make this work today. Thank you for your time.", 'no_deal');
  }
  if (onlyFee && script.last !== 'waiver') {
    script.last = 'waiver';
    return reply('Is there any way to waive that fee?', 'listen', 'countering', withCheck);
  }
  script.last = 'day';
  const acceptable = neg.callPlan.acceptableDays;
  const day = script.counters <= 1 ? neg.callPlan.targetDay : (acceptable[Math.min(script.counters - 1, acceptable.length - 1)] ?? neg.callPlan.targetDay);
  return reply(`Would ${formatWeekdayLong(day, h.day0Date)} work, with no fee?`, 'listen', 'countering', withCheck);
}

/**
 * What PacePay says once the deal approval is resolved. Idempotent: the first call after Yoshua
 * answers (or the 60 s timeout) records the line, closes the negotiation (which enqueues
 * CALL_ENDED) and publishes it; later calls return the same answer. Pending -> { status: 'pending' }.
 */
export function scriptedApprovalOutcome(ctx: ToolContext, negotiationId: string): VoiceApprovalResponse {
  const neg = ctx.store.mustGet('negotiations', negotiationId);
  const approval = latestDealApproval(ctx, negotiationId);
  if (!approval || approval.status === 'pending') return { status: 'pending' };
  const h = ctx.store.household();
  const offer = acceptedOffer(neg);
  const when = offer ? formatDate(offer.newDay, h.day0Date) : 'that day';
  const fee = offer ? spokenFee(offer.fee) : '';
  let status: VoiceApprovalResponse['status'];
  let say: string;
  let outcome: CallOutcome;
  if (approval.status === 'approved') {
    status = 'approved';
    outcome = 'deal';
    say = `Thank you, Yoshua approved. So the payment moves to ${when}, ${fee}. Thanks for your help. Goodbye.`;
  } else if (approval.status === 'declined') {
    status = 'declined';
    outcome = 'no_deal';
    say = "Thank you. Yoshua has decided not to go ahead with that, so we'll leave it as is. Goodbye.";
  } else {
    status = 'timeout';
    outcome = 'approval_timeout';
    say = `I haven't been able to reach Yoshua in time. Could you hold ${when} ${offer && offer.fee === 0 ? 'with no fee' : 'with that fee'} for him and give me a reference number? Thank you.`;
  }
  if (neg.state !== 'closed' || !neg.outcome) {
    pacepayLine(ctx, negotiationId, say, 'closed');
    closeNegotiation(ctx, negotiationId, outcome);
  }
  return { status, say, next: 'end_call' };
}

/** runTool('decide') for scripted negotiations reaches the script; any other negotiation goes to the previously registered decide. */
const WRAPPED = Symbol.for('pacepay.stub.decideWrapped');
function wrapDecideTool(): void {
  const prev = getTool('decide') as (ReturnType<typeof getTool> & { [WRAPPED]?: boolean }) | undefined;
  if (!prev || prev[WRAPPED]) return;
  const impl = (async (input: { negotiationId: string; utterance: string }, ctx: ToolContext, scope: ToolScope) =>
    isScriptedNegotiation(input.negotiationId) ? scriptedDecide(ctx, input.negotiationId, input.utterance) : prev.impl(input as never, ctx, scope)) as never;
  const wrapped = defineTool('decide', prev.input as never, prev.output as never, impl) as typeof prev;
  wrapped[WRAPPED] = true;
  registerTool(wrapped);
}

// ---------------------------------------------------------------------------
// CD_MATURING
// ---------------------------------------------------------------------------

async function onCdMaturing(ctx: ToolContext, event: Extract<AgentEvent, { type: 'CD_MATURING' }>): Promise<void> {
  abandonOpenCase(ctx);
  const h = ctx.store.household();
  const today = ctx.clock.today();
  const cd = h.accounts.find((a) => a.id === event.accountId);
  const c = openCase(ctx, 'cd_maturing', `${cd?.name ?? 'CD'} maturing`, `Decide what to do with the ${cd?.name ?? 'CD'} before it matures`, CD_STEPS, event.id);
  moveTo(ctx, c.id, 'ANALYZING');
  begin(ctx, c.id, 'cd_options');
  const hAccepted = ctx.engine.applyChanges(h, ctx.store.acceptedChanges());
  const options = ctx.engine.cdOptions(hAccepted, event.accountId, { fromDay: today });
  const payoff = options.find((o) => o.id === 'cd_payoff_card');
  const renew = options.find((o) => o.id === 'cd_renew');
  const ranked = [payoff, renew].filter((o): o is Option => !!o);
  ctx.store.patch('cases', c.id, { options: ranked });
  done(ctx, c.id, 'cd_options', ranked.map((o) => o.id).join(', '));
  if (!ranked.length) {
    skip(ctx, c.id, ['send_options', 'await_choice', 'schedule_followup'], 'no CD options');
    finish(ctx, c.id);
    return;
  }

  begin(ctx, c.id, 'send_options');
  const renewEarned = roundAbout(renew?.tradeoffs.yearlyInterestEarned ?? 0);
  let prompt: string;
  if (payoff) {
    const pay = payoff.changes.find((x): x is Extract<Change, { type: 'pay_down' }> => x.type === 'pay_down');
    const rest = payoff.changes.find((x): x is Extract<Change, { type: 'transfer' }> => x.type === 'transfer');
    prompt = cdAlertText({
      cdAmount: (pay?.amount ?? 0) + (rest?.amount ?? 0),
      maturesOn: event.maturesOn,
      payoff: pay?.amount ?? 0,
      toSavings: rest?.amount ?? 0,
      yearlySaved: roundAbout(payoff.tradeoffs.yearlyInterestSaved ?? 0),
      emergencyBefore: payoff.tradeoffs.emergencyMonthsBefore ?? 0,
      emergencyAfter: payoff.tradeoffs.emergencyMonthsAfter ?? 0,
      renewEarned,
      day0Date: h.day0Date,
    });
  } else {
    prompt = `Your ${formatWholeDollars(cd?.balance ?? 0)} CD matures ${formatDate(event.maturesOn, h.day0Date)}.\n1. Renew it: earns about ${formatWholeDollars(renewEarned)} a year\nReply 1 and I'll send the steps.`;
  }
  await runTool(
    'request_approval',
    { kind: 'option_choice', prompt, choices: ranked.map((_, i) => String(i + 1)), optionIds: ranked.map((o) => o.id) },
    ctx,
    scopeOf(ctx, c.id, 'send_options', { unprompted: true }),
  );
  done(ctx, c.id, 'send_options');
  moveTo(ctx, c.id, 'OPTIONS_SENT');
  moveTo(ctx, c.id, 'AWAITING_CHOICE');
  begin(ctx, c.id, 'await_choice');
}

async function cdChoice(ctx: ToolContext, caseId: string, opt: Option): Promise<void> {
  const h = ctx.store.household();
  const c = ctx.store.mustGet('cases', caseId);
  const maturesOn = h.accounts.find((a) => a.kind === 'cd')?.maturesOn ?? ctx.clock.today();
  moveTo(ctx, caseId, 'ADVISED');
  await say(ctx, scopeOf(ctx, caseId), cdChoiceReplyText({ maturesOn, day0Date: h.day0Date }));
  begin(ctx, caseId, 'schedule_followup');

  let steps: string;
  if (opt.id === 'cd_payoff_card') {
    const pay = opt.changes.find((x): x is Extract<Change, { type: 'pay_down' }> => x.type === 'pay_down');
    const rest = opt.changes.find((x): x is Extract<Change, { type: 'transfer' }> => x.type === 'transfer');
    const total = (pay?.amount ?? 0) + (rest?.amount ?? 0);
    steps = `Your ${formatWholeDollars(total)} CD matures today. 1. Pay off your card with ${formatWholeDollars(pay?.amount ?? 0)} from it.${rest ? ` 2. Move the other ${formatWholeDollars(rest.amount)} to savings.` : ''}`;
  } else {
    const cd = h.accounts.find((a) => a.kind === 'cd');
    steps = `Your ${formatWholeDollars(cd?.balance ?? 0)} CD matures today. To renew it, tell your bank to roll it over. It earns about ${formatWholeDollars(roundAbout(opt.tradeoffs.yearlyInterestEarned ?? 0))} a year.`;
  }
  await soft(ctx, 'schedule_followup', { atDay: Math.max(ctx.clock.today(), maturesOn), text: steps }, scopeOf(ctx, caseId, 'schedule_followup'));
  done(ctx, caseId, 'schedule_followup', `the morning of ${formatDate(maturesOn, h.day0Date)}`);
  if (opt.changes.length) commit(ctx, caseId, opt.changes, `Counted "${opt.label}" in the forecast`);
  else void c;
  finish(ctx, caseId);
}

// ---------------------------------------------------------------------------
// TEXT and the rest
// ---------------------------------------------------------------------------

async function onText(ctx: ToolContext, event: Extract<AgentEvent, { type: 'TEXT' }>): Promise<void> {
  const h = ctx.store.household();
  const fc = currentForecast(ctx, { days: 14 });
  const pending = ctx.store.pendingApprovals().sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
  let text = `${statusLineText({ lowest: fc.lowest, day0Date: h.day0Date })} in the next 14 days.`;
  if (pending?.kind === 'option_choice') text += ` ${replyPrompt(pending.choices.length)}`;
  else if (pending) text += ' Waiting on your YES or NO.';
  void event;
  await say(ctx, scopeOf(ctx, ctx.store.currentCase()?.id), text);
}

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

export function createStubAgent(ctx: ToolContext): Agent {
  wrapDecideTool();
  return {
    async handle(event) {
      try {
        switch (event.type) {
          case 'BILL_PHOTO':
            return await onBillPhoto(ctx, event);
          case 'BILL_CORRECTION':
            return await onBillCorrection(ctx, event);
          case 'CHOICE_REPLY':
            return await onChoice(ctx, event);
          case 'APPROVAL_REPLY':
            return await onApproval(ctx, event);
          case 'APPROVAL_TIMEOUT':
            return await onApprovalTimeout(ctx, event);
          case 'CALL_FAILED':
            return await onCallFailed(ctx, event);
          case 'CALL_ENDED':
            return await onCallEnded(ctx, event);
          case 'CD_MATURING':
            return await onCdMaturing(ctx, event);
          case 'TEXT':
            return await onText(ctx, event);
          default:
            ctx.bus.emit({ type: 'event.received', title: `Scripted agent ignored ${event.type}`, model: 'code', detail: event });
        }
      } catch (err) {
        const caseId = (event as { caseId?: string }).caseId ?? ctx.store.currentCase()?.id;
        ctx.bus.emit({
          type: 'step.failed',
          caseId,
          model: 'code',
          level: 'error',
          title: `Scripted agent failed on ${event.type}: ${(err as Error).message}`,
          detail: { stack: (err as Error).stack },
        });
      }
    },
  };
}
