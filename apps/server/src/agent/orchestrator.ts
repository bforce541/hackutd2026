/**
 * The real agent (SPEC §5): event -> planner (planner.ts) -> plan validation -> steps run by
 * Super with tools -> the state machine (machine.ts) enforcing the hard gates.
 * Implemented by: agent-core.
 *
 * Contracts other streams rely on:
 * - Only the agent changes case.state, always through machine.ts assertTransition. Moving to
 *   CALLING happens when place_call returns (dispatch waits until the lender answers), then
 *   NEGOTIATING; CALL_FAILED -> TEXT_NEGOTIATION; CALL_ENDED -> SUMMARIZING -> post_call_summary.
 * - Publish SSE `case` ({ case, plan, bill }) after every state or plan-step change, and
 *   publishForecast() (../forecast.ts) after anything that changes store.forecastChanges().
 * - The bill's payment goes into case.baseChanges as soon as read_bill returns (v2.md: the
 *   forecast counts the quote as paid from checking today); buildOptions gets the household
 *   with store.acceptedChanges() applied, never the baseChanges (the bill would count twice).
 * - option_choice approvals carry optionIds in the order texted (PacePay's pick first).
 *
 * How it runs: the plan drives. advance() walks the plan's steps in order and runs each pending
 * step's handler; a step that waits on Yoshua or the lender (await_choice, confirm_limits,
 * negotiate, read_bill with a bill check) stays 'running' and stops the walk. The event that ends
 * the wait (CHOICE_REPLY, APPROVAL_REPLY, CALL_ENDED...) finishes that step and walks on.
 * Numbers come only from the engine: every text is built from a facts object, Super's wording is
 * facts-checked (regenerated once, then the UI.md template is sent).
 */
import { z } from 'zod';
import {
  ACTOR_LABELS,
  ackText,
  alertText,
  billCheckText,
  billItemId,
  callingText,
  cardOptionText,
  cdAlertText,
  cdChoiceReplyText,
  contextItem,
  findDollarAmount,
  formatDate,
  formatDayRelative,
  formatMoney,
  formatOneDecimal,
  formatPercent,
  formatWholeDollars,
  limitsText,
  movePaymentOptionText,
  normalizeReply,
  paycheckLateAckText,
  paycheckLateCondition,
  paycheckWatchCancelledText,
  paycheckWatchKeptText,
  paycheckWatchText,
  paycheckDependsText,
  paycheckWhatIfText,
  reminderText,
  replyPrompt,
  savingsOptionText,
  type AgentEvent,
  type Forecast,
  type Lowest,
  type ScheduledItem,
  weekdayOf,
  type Approval,
  type Bill,
  type CallPlan,
  type Case,
  type CaseKind,
  type CaseState,
  type Cents,
  type Change,
  type Day,
  type Negotiation,
  type Option,
  type OptionId,
  type Plan,
  type PlanStep,
  type StepKind,
} from '@pacepay/shared';
import type { Agent } from './index';
import { runTool, type ToolContext, type ToolScope } from '../tools/registry';
import { CALL_STEP_KINDS, ultraTurn, writePlan } from './planner';
import { assertCaseTransition, assertPlaceCallAllowed, caseApprovals, GateError, isOpen } from './machine';
import { approvalOutcome, dealChanges, openingLine } from './negotiator';
import { answerQuestion } from './qa';
import { parseDay } from '../tools/simulate';
import { needsBillCheck } from '../tools/read_bill';
import { unsupportedNumbers } from '../tools/send_message';
import { currentForecast, publishForecast } from '../forecast';
import { sendText } from '../messaging/outbox';
import { timeoutApproval } from '../approvals';
import { loadPrompt } from '../prompts/load';
import { newId } from '../ids';
import type { ChatMessage } from '../models';


type Facts = Record<string, string>;
type StepResult = 'continue' | 'wait';

const CANNED_QA = "I can answer questions about your accounts, your forecast and your bills. Try: what's my lowest balance this month?";

/** Whole dollars, rounded for "about $550 a year" style phrases (the facts object decides rounding). */
function aboutCents(c: Cents): Cents {
  const abs = Math.abs(c);
  const step = abs >= 50_000 ? 5_000 : abs >= 10_000 ? 500 : 100;
  return Math.round(c / step) * step;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const baseItemId = (id: string) => id.split('@')[0]!.split(':')[0]!;

// "What if my paycheck is late?" and "My paycheck is going to be late, it's landing Monday": code paths,
// not model luck, so the demo's question always gets the engine's answer.
const PAYCHECK_WORDS = /\b(pay ?check|paycheque|pay ?day|direct deposit|salary|wages|my pay)\b/i;
const LATE_WORDS = /\b(late|delay(?:ed)?|slips?|slipped|pushed|won'?t (?:come|land|arrive|hit|clear)|doesn'?t (?:come|land|arrive|hit|clear)|(?:landing|lands|coming|arrives?|arriving|hits?|clears?) (?:on )?(?:mon|tues?|wed|thu|fri|sat|sun|next))/i;
const HYPOTHETICAL = /\b(what if|what happens|what would|suppose|in case|if)\b/i;
const WATCH_NO = /^(no|n|nah|nope|dont|do not|dont bother|dont watch|skip|skip it|no thanks|no thank you|stop|cancel|never ?mind|not needed)\b/;
const WATCH_OK = /^(ok|okay|k|kk|yes|y|yep|yeah|ya|sure|thanks|thank you|thx|ty|cool|great|perfect|sounds good|got it|good|nice|awesome|please|pls|do it|keep watching)\b/;
const WEEKDAY_WORD = /\b(mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\b/i;

export function createRealAgent(ctx: ToolContext): Agent {
  const h = () => ctx.store.household();
  const d0 = () => h().day0Date;
  const today = () => ctx.clock.today();
  /**
   * A scheduled item by id, including the ids a moved payment gets ("auto_payment@6" after the first
   * deal): those live only in the household with the changes applied, so fall back to the series.
   */
  const itemFor = (id: string): ScheduledItem | undefined => h().scheduled.find((s) => s.id === id) ?? h().scheduled.find((s) => s.id === id.split(/[@#:]/)[0]);

  // -------------------------------------------------------------------------
  // Case, plan and step bookkeeping
  // -------------------------------------------------------------------------

  const getCase = (id: string): Case => ctx.store.mustGet('cases', id);
  const getPlan = (c: Case): Plan | null => (c.planId ? (ctx.store.getItem('plans', c.planId) ?? null) : null);
  const getBill = (c: Case): Bill | null => (c.billId ? (ctx.store.getItem('bills', c.billId) ?? null) : null);
  const approvalsOf = (c: Case): Approval[] => caseApprovals(c, (id) => ctx.store.getItem('approvals', id));

  function publishCase(caseId: string): void {
    const c = getCase(caseId);
    ctx.bus.publish({ event: 'case', data: { case: c, plan: getPlan(c), bill: getBill(c) } });
  }

  function patchCase(caseId: string, patch: Partial<Case>): Case {
    const next = ctx.store.patch('cases', caseId, patch);
    publishCase(caseId);
    return next;
  }

  function moveTo(caseId: string, to: CaseState): Case {
    const c = getCase(caseId);
    if (c.state === to) return c;
    try {
      assertCaseTransition(c, to, approvalsOf(c));
    } catch (err) {
      ctx.bus.emit({ type: 'step.failed', model: 'code', caseId, level: 'error', title: `Gate refused ${c.state} → ${to}: ${(err as Error).message}`, detail: { from: c.state, to } });
      throw err;
    }
    return patchCase(caseId, { state: to, ...(to === 'DONE' ? { closedAt: ctx.clock.now() } : {}) });
  }

  function findStep(c: Case, kind: StepKind): PlanStep | undefined {
    const p = getPlan(c);
    if (!p) return undefined;
    return p.steps.find((s) => s.kind === kind && (s.status === 'pending' || s.status === 'running')) ?? p.steps.find((s) => s.kind === kind);
  }

  function patchStep(c: Case, stepId: string, patch: Partial<PlanStep>): void {
    const p = getPlan(c);
    if (!p) return;
    ctx.store.patch('plans', p.id, { steps: p.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)) });
    publishCase(c.id);
  }

  function scopeFor(c: Case, step?: PlanStep, extra: Partial<ToolScope> = {}): ToolScope {
    return { caseId: c.id, planId: c.planId, stepId: step?.id, caller: 'orchestrator', model: step?.model ?? 'code', ...extra };
  }

  function startStep(c: Case, kind: StepKind): PlanStep | undefined {
    const s = findStep(c, kind);
    if (!s || s.status === 'running') return s;
    patchStep(c, s.id, { status: 'running', startedAt: ctx.clock.now(), endedAt: undefined });
    ctx.bus.emit({ type: 'step.started', caseId: c.id, planId: c.planId, stepId: s.id, model: s.model, title: s.title });
    return { ...s, status: 'running' };
  }

  function endStep(c: Case, kind: StepKind, status: 'done' | 'skipped' | 'failed', note?: string): void {
    const s = findStep(c, kind);
    if (!s || s.status === status) return;
    patchStep(c, s.id, { status, note, endedAt: ctx.clock.now(), startedAt: s.startedAt ?? ctx.clock.now() });
    const type = status === 'done' ? 'step.completed' : status === 'skipped' ? 'step.skipped' : 'step.failed';
    ctx.bus.emit({
      type,
      caseId: c.id,
      planId: c.planId,
      stepId: s.id,
      model: s.model,
      level: status === 'failed' ? 'warn' : 'info',
      title: note ? `${s.title}: ${note}` : s.title,
    });
  }
  const doneStep = (c: Case, kind: StepKind, note?: string) => endStep(c, kind, 'done', note);
  const skipStep = (c: Case, kind: StepKind, note: string) => endStep(c, kind, 'skipped', note);

  /** Adds a step the branch needs when the plan has none pending (SPEC §5.2: card/savings adds a send_message). */
  function ensureStep(c: Case, kind: StepKind, title: string, model: PlanStep['model'], afterKind: StepKind): PlanStep {
    const p = getPlan(c)!;
    const existing = p.steps.find((s) => s.kind === kind && s.status === 'pending');
    if (existing) return existing;
    const step: PlanStep = { id: newId('step'), kind, title, model, status: 'pending' };
    const at = p.steps.findIndex((s) => s.kind === afterKind);
    const steps = [...p.steps];
    steps.splice(at >= 0 ? at + 1 : steps.length, 0, step);
    ctx.store.patch('plans', p.id, { steps });
    publishCase(c.id);
    return step;
  }

  /** Runs `fn` as a step that may or may not be in the plan (it is added after `afterKind`). */
  async function inlineStep<T>(c: Case, kind: StepKind, title: string, model: PlanStep['model'], afterKind: StepKind, fn: (s: PlanStep) => Promise<T>): Promise<T> {
    ensureStep(c, kind, title, model, afterKind);
    const s = startStep(c, kind)!;
    const out = await fn(s);
    doneStep(getCase(c.id), kind);
    return out;
  }

  function skipPending(c: Case, kinds: readonly StepKind[], note: string): void {
    for (const k of kinds) {
      const s = findStep(getCase(c.id), k);
      if (s && (s.status === 'pending' || s.status === 'running')) skipStep(getCase(c.id), k, note);
    }
  }

  // -------------------------------------------------------------------------
  // Changes and the forecast
  // -------------------------------------------------------------------------

  /** Moves the case's changes (or `replace`) into acceptedChanges and clears baseChanges, once. */
  function commit(caseId: string, extra: Change[] = [], opts: { replace?: Change[]; title?: string } = {}): void {
    const c = getCase(caseId);
    const changes = opts.replace ?? [...(c.baseChanges ?? []), ...extra];
    if (changes.length) ctx.store.addAcceptedChanges(changes);
    patchCase(caseId, { baseChanges: [], acceptedChanges: [...(c.acceptedChanges ?? []), ...changes] });
    publishForecast(ctx, { caseId, title: opts.title ?? 'Updated the forecast' });
  }

  function billChangeFor(bill: Bill): Change {
    const ch = ctx.engine.billChange(h(), { amount: bill.amount, day: Math.max(bill.dueDay ?? today(), today()), label: bill.merchant });
    if (ch.type !== 'add_item') return ch;
    return { ...ch, item: { ...ch.item, id: billItemId(bill.id) } };
  }

  function billNoun(bill: Bill | null): string {
    if (!bill) return 'bill';
    return /repair|brake|rotor|mechanic|auto service|tire|labor/i.test(`${bill.merchant} ${bill.description}`) ? 'repair' : 'bill';
  }

  function caseTitle(bill: Bill): string {
    const noun = billNoun(bill);
    return noun === 'repair' ? `The ${formatWholeDollars(bill.amount)} repair` : `The ${formatWholeDollars(bill.amount)} bill from ${bill.merchant}`;
  }

  // -------------------------------------------------------------------------
  // Texts: Super writes, code checks, templates catch
  // -------------------------------------------------------------------------

  async function writeText(
    c: Case,
    step: PlanStep | undefined,
    o: { instruction: string; facts: Facts; template: string; validate?: (text: string) => string | null },
  ): Promise<string> {
    const templateBad = unsupportedNumbers(o.template, o.facts);
    if (templateBad.length) {
      ctx.bus.emit({ type: 'step.failed', model: 'code', caseId: c.id, stepId: step?.id, level: 'warn', title: `Template text has numbers missing from the facts: ${templateBad.join(', ')}`, detail: { template: o.template, facts: o.facts } });
    }
    if (!ctx.models.available('orchestrator')) return o.template;
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: loadPrompt('orchestrator', { person_name: h().person.name, step_title: step?.title ?? 'Text Yoshua', facts_json: JSON.stringify(o.facts, null, 1) }),
      },
      { role: 'user', content: `${o.instruction}\nReply with only the text message itself: no quotes, no preamble.` },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      let text: string;
      try {
        const res = await ctx.models.chat({ role: 'orchestrator', messages, caseId: c.id, stepId: step?.id, title: `Super wrote: ${step?.title ?? 'a text'}` });
        text = clean(res.text);
        messages.push({ role: 'assistant', content: res.text });
      } catch {
        break; // the client already retried once
      }
      const missing = unsupportedNumbers(text, o.facts);
      const problem = !text ? 'The reply was empty.' : missing.length ? `These numbers are not in FACTS: ${missing.join(', ')}. Use only numbers from FACTS, copied exactly.` : (o.validate?.(text) ?? null);
      if (!problem) return text;
      ctx.bus.emit({ type: 'step.failed', model: 'nemotron-super', caseId: c.id, stepId: step?.id, level: 'warn', title: attempt === 0 ? `Text failed the check, rewriting: ${problem}` : 'Text failed the check again; sending the template', detail: { text, problem } });
      messages.push({ role: 'user', content: `${problem} Rewrite it.` });
    }
    return o.template;
  }

  function clean(text: string): string {
    return text
      .trim()
      .replace(/^```[a-z]*\s*|\s*```$/g, '')
      .replace(/^["“](.*)["”]$/s, '$1')
      .replace(/\*\*/g, '')
      .trim();
  }

  async function sendMessage(c: Case, step: PlanStep | undefined, text: string, facts: Facts, extra: Partial<ToolScope> = {}): Promise<void> {
    try {
      await runTool('send_message', { text, facts }, ctx, scopeFor(c, step, extra));
    } catch (err) {
      // A facts failure here is a code bug in a template; the text is engine-built, so send it and say so.
      ctx.bus.emit({ type: 'step.failed', model: 'code', caseId: c.id, stepId: step?.id, level: 'error', title: `send_message refused a text (${(err as Error).message}); sending it directly`, detail: { text, facts } });
      await sendText(ctx, text, { caseId: c.id, stepId: step?.id, unprompted: extra.unprompted });
    }
  }

  async function requestApproval(c: Case, step: PlanStep | undefined, input: { kind: Approval['kind']; prompt: string; choices: string[]; optionIds?: OptionId[] }): Promise<string> {
    const out = await runTool('request_approval', input, ctx, scopeFor(c, step));
    return out.approvalId;
  }

  // -------------------------------------------------------------------------
  // Options: facts, ranking, texts
  // -------------------------------------------------------------------------

  interface MoveInfo {
    itemId: string;
    itemLabel: string;
    toDay: Day;
    counterpartyId?: string;
  }

  function moveInfo(o: Option): MoveInfo | null {
    const mv = o.changes.find((ch): ch is Extract<Change, { type: 'move_item' }> => ch.type === 'move_item');
    if (!mv) return null;
    const item = itemFor(mv.itemId);
    return { itemId: mv.itemId, itemLabel: lower(item?.label ?? 'payment'), toDay: mv.toDay, counterpartyId: item?.counterpartyId };
  }

  function savingsAmount(o: Option): Cents {
    const t = o.changes.find((ch): ch is Extract<Change, { type: 'transfer' }> => ch.type === 'transfer');
    return t?.amount ?? 0;
  }

  function optionBody(o: Option): string {
    switch (o.id) {
      case 'move_payment': {
        const m = moveInfo(o)!;
        // A payment a lender already moved once ("auto_payment@6") is asked about "again".
        return movePaymentOptionText({ itemLabel: m.itemId.includes('@') ? `${m.itemLabel} again` : m.itemLabel, toDay: m.toDay, day0Date: d0() });
      }
      case 'card':
        return cardOptionText({ monthlyInterest: o.tradeoffs.monthlyInterest ?? 0 });
      case 'savings':
        return savingsOptionText({ amount: savingsAmount(o), savingsFloor: h().rules.savingsFloor, belowFloor: o.violations.includes('BELOW_SAVINGS_FLOOR') });
      default:
        return o.label;
    }
  }

  const DEFAULT_PICK: Record<OptionId, string> = {
    move_payment: 'no new debt',
    savings: 'no new debt',
    card: 'keeps your savings',
    cd_payoff_card: 'saves the most',
    cd_renew: 'keeps the CD earning',
  };

  /** Code's ranking, and the floor under any model ranking: rule-breaking options never lead, new debt leads only when nothing else is clean. */
  function codeRank(options: Option[]): Option[] {
    const pref: OptionId[] = ['move_payment', 'cd_payoff_card', 'savings', 'card', 'cd_renew'];
    return [...options].sort((a, b) => {
      const va = a.violations.length ? 1 : 0;
      const vb = b.violations.length ? 1 : 0;
      if (va !== vb) return va - vb;
      return pref.indexOf(a.id) - pref.indexOf(b.id);
    });
  }

  function optionSummary(o: Option): string {
    const t = o.tradeoffs;
    const parts = [`${o.id}: ${o.label}`, `lowest checking ${formatMoney(o.lowest.amount)} on ${formatDate(o.lowest.day, d0())}`];
    if (t.monthlyInterest !== null) parts.push(`about ${formatWholeDollars(t.monthlyInterest)}/mo interest (new debt)`);
    if (t.creditUseBefore !== null && t.creditUseAfter !== null) parts.push(`card use ${formatPercent(t.creditUseBefore)} -> ${formatPercent(t.creditUseAfter)}`);
    if (t.savingsAfter !== null) parts.push(`savings after ${formatMoney(t.savingsAfter)}`);
    if (t.emergencyMonthsBefore !== null && t.emergencyMonthsAfter !== null) parts.push(`emergency fund ${formatOneDecimal(t.emergencyMonthsBefore)} -> ${formatOneDecimal(t.emergencyMonthsAfter)} months`);
    if (t.yearlyInterestSaved !== null) parts.push(`saves about ${formatWholeDollars(aboutCents(t.yearlyInterestSaved))} a year in interest`);
    if (t.yearlyInterestEarned !== null) parts.push(`earns about ${formatWholeDollars(aboutCents(t.yearlyInterestEarned))} a year`);
    if (o.id === 'move_payment') parts.push('needs a call to the lender, no new debt');
    parts.push(o.violations.length ? `breaks rules: ${o.violations.join(', ')}` : 'breaks no rules');
    return parts.join('; ');
  }

  const RankSchema = z.object({ order: z.array(z.string()), pickReason: z.string() });

  /** Ultra (or Super) ranks; code keeps the order honest. Returns the ranked options and the pick reason. */
  async function rankOptions(c: Case, step: PlanStep | undefined, options: Option[]): Promise<{ ranked: Option[]; pickReason: string }> {
    const fallback = codeRank(options);
    if (options.length < 2) return { ranked: fallback, pickReason: DEFAULT_PICK[fallback[0]?.id ?? 'move_payment'] };
    try {
      const res = await ctx.models.chat({
        role: 'planner',
        caseId: c.id,
        stepId: step?.id,
        title: 'Ranked the options',
        json: RankSchema,
        messages: [
          {
            role: 'system',
            content:
              `You rank money options for ${h().person.name}. Prefer options that break none of his rules, then options that add no new debt, then the smallest cost. ` +
              'Never calculate. Return {"order": [option ids, best first], "pickReason": "<why the first is best, at most 6 words, no numbers>"}.',
          },
          { role: 'user', content: options.map(optionSummary).join('\n') },
        ],
      });
      const ids = res.json.order.map((id) => id.trim().replace(/^id[\s:=]+/i, '').replace(/[^a-z_]/gi, ''));
      const byId = new Map(options.map((o) => [o.id as string, o]));
      const valid = ids.length === options.length && new Set(ids).size === ids.length && ids.every((id) => byId.has(id));
      if (!valid) throw new Error(`not a ranking of ${options.map((o) => o.id).join(', ')}: ${ids.join(', ')}`);
      const ranked = ids.map((id) => byId.get(id)!);
      // Code's floor: the model may not put a rule-breaking or new-debt option first when a clean, debt-free one exists.
      if (ranked[0]!.id !== fallback[0]!.id && (ranked[0]!.violations.length > 0 || ranked[0]!.id === 'card') && fallback[0]!.violations.length === 0 && fallback[0]!.id !== 'card') {
        ctx.bus.emit({ type: 'step.completed', model: 'code', caseId: c.id, stepId: step?.id, level: 'warn', title: `Kept ${fallback[0]!.label.toLowerCase()} first: the model's pick adds debt or breaks a rule` });
        return { ranked: [fallback[0]!, ...ranked.filter((o) => o.id !== fallback[0]!.id)], pickReason: DEFAULT_PICK[fallback[0]!.id] };
      }
      const reason = res.json.pickReason.trim().replace(/[.!]+$/, '').toLowerCase();
      const okReason = reason.length > 0 && reason.length <= 48 && !/[\d$%]/.test(reason);
      return { ranked, pickReason: okReason ? reason : DEFAULT_PICK[ranked[0]!.id] };
    } catch (err) {
      ctx.bus.emit({ type: 'step.completed', model: 'code', caseId: c.id, stepId: step?.id, level: 'warn', title: `Ranked the options in code (${(err as Error).message})` });
      return { ranked: fallback, pickReason: DEFAULT_PICK[fallback[0]!.id] };
    }
  }

  /** "mortgage Mon, car payment Tue, paycheck Thu": the dip's causes and the paycheck that ends it. */
  function contextItems(): string[] {
    const f = currentForecast(ctx, { days: 30 });
    const out: string[] = [];
    const lowDay = f.lowest.day;
    for (const id of f.lowest.causeItemIds) {
      const day = f.days.find((d) => d.day <= lowDay && d.items.some((i) => i.itemId === id));
      const item = h().scheduled.find((s) => s.id === baseItemId(id));
      if (day && item) out.push(contextItem(lower(item.label), day.day, { day0Date: d0() }));
    }
    const payday = f.days.find((d) => d.day > lowDay && d.items.some((i) => h().scheduled.find((s) => s.id === baseItemId(i.itemId))?.kind === 'paycheck'));
    if (payday) out.push(contextItem('paycheck', payday.day, { day0Date: d0() }));
    return out;
  }

  function optionFacts(options: Option[]): Facts {
    const f: Facts = {};
    for (const o of options) {
      const t = o.tradeoffs;
      f[`${o.id}_option`] = optionBody(o);
      if (t.monthlyInterest !== null) f[`${o.id}_monthly_interest`] = `about ${formatWholeDollars(t.monthlyInterest)}/mo`;
      if (t.creditUseBefore !== null) f[`${o.id}_card_use_before`] = formatPercent(t.creditUseBefore);
      if (t.creditUseAfter !== null) f[`${o.id}_card_use_after`] = formatPercent(t.creditUseAfter);
      if (t.savingsAfter !== null) f[`${o.id}_savings_after`] = formatMoney(t.savingsAfter);
      if (o.id === 'savings') f.savings_amount = formatWholeDollars(savingsAmount(o));
      if (t.emergencyMonthsBefore !== null) f[`${o.id}_emergency_months_before`] = formatOneDecimal(t.emergencyMonthsBefore);
      if (t.emergencyMonthsAfter !== null) f[`${o.id}_emergency_months_after`] = formatOneDecimal(t.emergencyMonthsAfter);
      const m = moveInfo(o);
      if (m) f[`${o.id}_new_day`] = formatDate(m.toDay, d0());
    }
    f.savings_floor = formatWholeDollars(h().rules.savingsFloor);
    f.checking_floor = formatWholeDollars(h().rules.checkingFloor);
    return f;
  }

  const OPTION_WORD: Record<OptionId, RegExp> = {
    move_payment: /lender|move/i,
    card: /card/i,
    savings: /savings/i,
    cd_payoff_card: /card/i,
    cd_renew: /renew/i,
  };

  /** The numbered lines must be the options in the order the approval records. */
  function numberedCheck(ranked: Option[], firstLine: RegExp): (text: string) => string | null {
    return (text) => {
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!firstLine.test(lines[0] ?? '')) return `The first line must start like: ${firstLine.source.replace(/[\\^]/g, '')}`;
      for (let i = 0; i < ranked.length; i++) {
        const line = lines.find((l) => l.startsWith(`${i + 1}.`));
        if (!line) return `Option ${i + 1} must be its own line starting "${i + 1}."`;
        if (!OPTION_WORD[ranked[i]!.id].test(line)) return `Line ${i + 1} must be the ${ranked[i]!.label.toLowerCase()} option, in the order given.`;
      }
      if (lines.some((l) => /^\d+\./.test(l) && Number(l.split('.')[0]) > ranked.length)) return `There are only ${ranked.length} options.`;
      if (!/reply/i.test(lines[lines.length - 1] ?? '')) return `End with "${replyPrompt(ranked.length)}"`;
      if (text.length > 700) return 'Too long; keep it short.';
      return null;
    };
  }

  // -------------------------------------------------------------------------
  // Step handlers
  // -------------------------------------------------------------------------

  async function stepReadBill(c: Case, step: PlanStep, mediaId: string): Promise<StepResult> {
    let out;
    try {
      out = await runTool('read_bill', { mediaId }, ctx, scopeFor(c, step));
    } catch (err) {
      endStep(c, 'read_bill', 'failed', `Could not read the photo (${(err as Error).message})`);
      await sendMessage(c, step, "I couldn't read that photo. Can you text me the amount and when it's due?", {});
      return 'wait';
    }
    const bill = getBill(getCase(c.id));
    if (!bill) {
      endStep(c, 'read_bill', 'failed', 'The bill was not stored');
      return 'wait';
    }
    patchCase(c.id, { title: caseTitle(bill), baseChanges: [billChangeFor(bill)] });
    publishForecast(ctx, { caseId: c.id, title: `Counted ${formatMoney(bill.amount)} to ${bill.merchant} as paid from checking` });
    const p = { merchant: bill.merchant, amount: bill.amount, dueDay: bill.dueDay, today: today(), day0Date: d0() };
    if (needsBillCheck(out)) {
      await requestApproval(getCase(c.id), step, { kind: 'bill_confirm', prompt: billCheckText(p), choices: ['yes', 'no'] });
      patchStep(getCase(c.id), step.id, { note: 'Not sure of the read; asked Yoshua to confirm' });
      return 'wait';
    }
    await sendAck(getCase(c.id), step, bill);
    doneStep(getCase(c.id), 'read_bill', `${formatMoney(bill.amount)} to ${bill.merchant}${bill.dueDay !== null ? `, due ${formatDayRelative(bill.dueDay, today(), d0())}` : ''}`);
    return 'continue';
  }

  async function sendAck(c: Case, step: PlanStep | undefined, bill: Bill): Promise<void> {
    const p = { merchant: bill.merchant, amount: bill.amount, dueDay: bill.dueDay, today: today(), day0Date: d0() };
    const facts: Facts = { merchant: bill.merchant, amount: formatMoney(bill.amount), due: bill.dueDay !== null ? formatDayRelative(bill.dueDay, today(), d0()) : 'no due date printed' };
    const template = ackText(p);
    const text = await writeText(c, step, {
      instruction: `Acknowledge the bill photo in one short line: restate the merchant, the amount and when it's due, then say you're checking the week. Example shape: "${template}"`,
      facts,
      template,
      validate: (t) => (!t.includes(bill.merchant) ? `Name the merchant exactly: ${bill.merchant}.` : t.split('\n').length > 2 ? 'One line only.' : null),
    });
    await sendMessage(c, step, text, facts);
  }

  function stepForecast(c: Case): StepResult {
    startStep(c, 'forecast');
    const f = currentForecast(ctx, { days: 14 });
    doneStep(getCase(c.id), 'forecast', `Lowest ${formatMoney(f.lowest.amount)} on ${formatDate(f.lowest.day, d0())}`);
    return 'continue';
  }

  async function stepBuildOptions(c: Case, step: PlanStep): Promise<StepResult> {
    const bill = getBill(c);
    const fromDay = today();
    const hh = ctx.engine.applyChanges(h(), ctx.store.acceptedChanges());
    let options: Option[];
    if (bill) {
      options = ctx.engine.buildOptions(hh, { amount: bill.amount, day: Math.max(bill.dueDay ?? fromDay, fromDay), label: bill.merchant }, { fromDay });
    } else {
      // A shortfall with no new bill: card has nothing to charge, so only savings and moving a payment.
      options = ctx.engine.buildOptions(hh, { amount: 0, day: fromDay, label: 'Nothing new' }, { fromDay }).filter((o) => o.id !== 'card');
    }
    const { ranked, pickReason } = await rankOptions(c, step, options);
    patchCase(c.id, { options: ranked });
    pickReasons.set(c.id, pickReason);
    doneStep(getCase(c.id), 'build_options', ranked.map((o, i) => `${i + 1}. ${o.label}`).join(' · '));
    return 'continue';
  }

  async function stepCdOptions(c: Case, step: PlanStep, accountId: string): Promise<StepResult> {
    const hh = ctx.engine.applyChanges(h(), ctx.store.acceptedChanges());
    const options = ctx.engine.cdOptions(hh, accountId, { fromDay: today() });
    const { ranked, pickReason } = await rankOptions(c, step, options);
    patchCase(c.id, { options: ranked });
    pickReasons.set(c.id, pickReason);
    doneStep(getCase(c.id), 'cd_options', ranked.map((o, i) => `${i + 1}. ${o.label}`).join(' · '));
    return 'continue';
  }

  const pickReasons = new Map<string, string>();
  const cdAccounts = new Map<string, { accountId: string; maturesOn: Day }>();

  async function stepSendOptions(c: Case, step: PlanStep): Promise<StepResult> {
    const ranked = c.options ?? [];
    if (!ranked.length) {
      endStep(c, 'send_options', 'failed', 'No options to send');
      return 'wait';
    }
    if (c.kind === 'cd_maturing') return sendCdAlert(c, step, ranked);

    // The chart goes out just before the alert text (SPEC §6).
    try {
      await runTool('send_chart', { kind: 'week' }, ctx, scopeFor(c, step));
    } catch (err) {
      ctx.bus.emit({ type: 'step.failed', model: 'code', caseId: c.id, stepId: step.id, level: 'warn', title: `Chart not sent: ${(err as Error).message}` });
    }
    const bill = getBill(c);
    const f = currentForecast(ctx, { days: 30 });
    const late = lateCases.get(c.id);
    // A late paycheck leads with the day checking first dips (the payment that overdraws), as the what-if did.
    const head: Lowest = late ? (firstDip(f) ?? f.lowest) : f.lowest;
    const condition = bill
      ? `if you pay the ${billNoun(bill)} ${formatDayRelative(Math.max(bill.dueDay ?? today(), today()), today(), d0())}`
      : late
        ? paycheckLateCondition({ lateDay: late.lateDay, day0Date: d0() })
        : 'if nothing changes';
    const context = late ? [] : contextItems();
    const pickReason = pickReasons.get(c.id) ?? DEFAULT_PICK[ranked[0]!.id];
    const template = alertText({ lowest: head, condition, context, options: ranked.map(optionBody), pickReason, day0Date: d0() });
    const facts: Facts = {
      lowest: formatMoney(head.amount),
      lowest_date: formatDate(head.day, d0()),
      condition,
      context: context.join(', '),
      ...(bill ? { bill_amount: formatMoney(bill.amount), merchant: bill.merchant } : {}),
      ...optionFacts(ranked),
      option_order: ranked.map((o, i) => `${i + 1}. ${o.id}`).join(', '),
      pick_reason: pickReason,
      reply: replyPrompt(ranked.length),
    };
    const text = await writeText(c, step, {
      instruction:
        `Write the heads-up text with the options. First line: "Heads up: <lowest> on <lowest_date> <condition>${context.length ? ' (<context>)' : ''}." ` +
        `Then one line per option in option_order, numbered 1, 2, 3, using each option's own wording from FACTS; after option 1 add ". My pick: <pick_reason>". ` +
        `Last line: <reply>. Example shape:\n${template}`,
      facts,
      template,
      validate: numberedCheck(ranked, /^Heads up/i),
    });
    await requestApproval(c, step, { kind: 'option_choice', prompt: text, choices: ranked.map((_, i) => String(i + 1)), optionIds: ranked.map((o) => o.id) });
    doneStep(getCase(c.id), 'send_options', `Sent ${ranked.length} options; PacePay's pick: ${ranked[0]!.label.toLowerCase()}`);
    moveTo(c.id, 'OPTIONS_SENT');
    return 'continue';
  }

  async function sendCdAlert(c: Case, step: PlanStep, ranked: Option[]): Promise<StepResult> {
    const info = cdAccounts.get(c.id);
    const cd = h().accounts.find((a) => a.id === (info?.accountId ?? 'cd'));
    const maturesOn = info?.maturesOn ?? cd?.maturesOn ?? today();
    const payoff = ranked.find((o) => o.id === 'cd_payoff_card');
    const renew = ranked.find((o) => o.id === 'cd_renew');
    const pd = payoff?.changes.find((ch): ch is Extract<Change, { type: 'pay_down' }> => ch.type === 'pay_down');
    const tr = payoff?.changes.find((ch): ch is Extract<Change, { type: 'transfer' }> => ch.type === 'transfer');
    const t = payoff?.tradeoffs;
    const cdAmount = (pd?.amount ?? 0) + (tr?.amount ?? 0) || cd?.balance || 0;
    const facts: Facts = {
      cd_amount: formatWholeDollars(cdAmount),
      matures_on: formatDate(maturesOn, d0()),
      payoff_to_card: formatWholeDollars(pd?.amount ?? 0),
      to_savings: formatWholeDollars(tr?.amount ?? 0),
      yearly_interest_saved: `about ${formatWholeDollars(aboutCents(t?.yearlyInterestSaved ?? 0))} a year`,
      emergency_months_before: formatOneDecimal(t?.emergencyMonthsBefore ?? 0),
      emergency_months_after: formatOneDecimal(t?.emergencyMonthsAfter ?? 0),
      renew_earns: `about ${formatWholeDollars(aboutCents(renew?.tradeoffs.yearlyInterestEarned ?? 0))} a year`,
      option_order: ranked.map((o, i) => `${i + 1}. ${o.id}`).join(', '),
      reply: `${replyPrompt(ranked.length).replace(/\.$/, '')} and I'll send the steps.`,
    };
    let template: string;
    if (payoff && renew && ranked[0]!.id === 'cd_payoff_card') {
      template = cdAlertText({
        cdAmount,
        maturesOn,
        payoff: pd?.amount ?? 0,
        toSavings: tr?.amount ?? 0,
        yearlySaved: aboutCents(t?.yearlyInterestSaved ?? 0),
        emergencyBefore: t?.emergencyMonthsBefore ?? 0,
        emergencyAfter: t?.emergencyMonthsAfter ?? 0,
        renewEarned: aboutCents(renew.tradeoffs.yearlyInterestEarned ?? 0),
        day0Date: d0(),
      });
    } else {
      const lines = ranked.map((o, i) =>
        o.id === 'cd_renew'
          ? `${i + 1}. Renew it: earns ${facts.renew_earns}${i === 0 ? `. My pick: ${pickReasons.get(c.id) ?? DEFAULT_PICK.cd_renew}` : ''}`
          : `${i + 1}. Pay off your card (${facts.payoff_to_card}) and put ${facts.to_savings} in savings${i === 0 ? `. My pick: ${pickReasons.get(c.id) ?? DEFAULT_PICK.cd_payoff_card}` : ''}`,
      );
      template = [`Your ${facts.cd_amount} CD matures ${facts.matures_on}.`, ...lines, facts.reply!].join('\n');
    }
    const text = await writeText(c, step, {
      instruction:
        'Write the CD alert. First line: "Your <cd_amount> CD matures <matures_on>." Then the options in option_order, numbered; option 1 ends with "My pick: " and why in one clause (the yearly saving, and the emergency fund going from <emergency_months_before> to <emergency_months_after> months). ' +
        `Last line: <reply>. Example shape:\n${template}`,
      facts,
      template,
      validate: numberedCheck(ranked, /^Your .*CD matures/i),
    });
    await requestApproval(c, step, { kind: 'option_choice', prompt: text, choices: ranked.map((_, i) => String(i + 1)), optionIds: ranked.map((o) => o.id) });
    doneStep(getCase(c.id), 'send_options', `Sent the CD alert; PacePay's pick: ${ranked[0]!.label.toLowerCase()}`);
    moveTo(c.id, 'OPTIONS_SENT');
    return 'continue';
  }

  function stepAwaitChoice(c: Case): StepResult {
    startStep(c, 'await_choice');
    moveTo(c.id, 'AWAITING_CHOICE');
    return 'wait';
  }

  function chosenMove(c: Case): MoveInfo | null {
    const o = c.options?.find((x) => x.id === 'move_payment');
    return o ? moveInfo(o) : null;
  }

  async function stepGetTerms(c: Case, step: PlanStep): Promise<StepResult> {
    const m = chosenMove(c);
    if (!m?.counterpartyId) {
      skipStep(c, 'get_terms', 'No lender to look up');
      return 'continue';
    }
    try {
      const out = await runTool('get_terms', { counterpartyId: m.counterpartyId, question: `Can the ${m.itemLabel} due date be moved, and is there a fee or grace period?` }, ctx, scopeFor(c, step));
      termsByCase.set(c.id, out.passages.map((p) => p.text));
      doneStep(getCase(c.id), 'get_terms', `${out.passages.length} passage${out.passages.length === 1 ? '' : 's'} from the terms`);
    } catch (err) {
      endStep(getCase(c.id), 'get_terms', 'skipped', `Proceeding without terms (${(err as Error).message})`);
    }
    return 'continue';
  }
  const termsByCase = new Map<string, string[]>();

  function greeting(m: MoveInfo, lender: string): string {
    const loan = h().accounts.find((a) => a.kind === 'auto_loan' && m.counterpartyId === 'auto_lender') ?? h().accounts.find((a) => a.isLiability && a.reference);
    const ref = loan ? `the ${lower(loan.name)} ${loan.reference ?? ''}`.trim() : `the ${m.itemLabel}`;
    return `Hi, I'm PacePay, an AI assistant calling on behalf of ${h().person.name}, with ${h().person.name}'s permission, about ${ref}. This call is transcribed.`;
  }

  function templateWording(m: MoveInfo, dueDay: Day | undefined, targetDay: Day, nextBest: string): Pick<CallPlan, 'goal' | 'openingAsk' | 'walkAway' | 'fallbackText'> {
    const from = dueDay !== undefined ? ` from ${formatDate(dueDay, d0())}` : '';
    return {
      goal: `Move the ${m.itemLabel}${from} to ${formatDate(targetDay, d0())} or another day that works`,
      openingAsk: `Ask to move this month's ${m.itemLabel} to ${formatDate(targetDay, d0())}, with no fee.`,
      walkAway: 'If they refuse, need to verify the account holder, or offer nothing that works after two counters, thank them, take a reference number if offered, and end the call.',
      fallbackText: nextBest,
    };
  }

  const WordingSchema = z.object({ goal: z.string().min(1), openingAsk: z.string().min(1), walkAway: z.string().min(1) });
  const FORBIDDEN_ON_CALL = /\$|\d+\s?%|balance|paycheck|payday|floor|limit|overdra|savings|checking|income/i;

  async function callWording(c: Case, step: PlanStep | undefined, m: MoveInfo, dueDay: Day | undefined, targets: { targetDay: Day; acceptableDays: Day[] }, lender: string, issues?: string[]): Promise<Pick<CallPlan, 'goal' | 'openingAsk' | 'walkAway'> | null> {
    const terms = termsByCase.get(c.id) ?? [];
    const user = [
      `Lender: ${lender}. Payment: ${m.itemLabel}${dueDay !== undefined ? `, due ${formatDate(dueDay, d0())}` : ''}.`,
      `The engine's target day: ${formatDate(targets.targetDay, d0())}. Other days that work: ${targets.acceptableDays.slice(1, 5).map((d) => formatDate(d, d0())).join(', ') || 'none'}.`,
      terms.length ? `From the loan terms:\n${terms.slice(0, 3).map((t) => `- ${t.slice(0, 400)}`).join('\n')}` : 'No terms passages.',
      issues?.length ? `A reviewer asked for these fixes:\n${issues.map((i) => `- ${i}`).join('\n')}` : '',
      'Write the call plan wording as JSON {"goal": one line, "openingAsk": what PacePay asks for first (the target day, no fee), "walkAway": when PacePay stops and ends the call politely}.',
      'These lines may be heard by the lender: never mention money amounts, balances, paychecks, savings, floors, limits, or why a day does not work.',
    ]
      .filter(Boolean)
      .join('\n');
    try {
      const res = await ctx.models.chat({
        role: 'planner',
        caseId: c.id,
        stepId: step?.id,
        title: issues ? 'Revised the call plan wording' : 'Planned the call',
        json: WordingSchema,
        messages: [
          { role: 'system', content: `You plan a short, polite phone call in which PacePay, an AI assistant, asks ${lender} to move one payment for ${h().person.name}. You never calculate; the engine picked the days.` },
          { role: 'user', content: user },
        ],
      });
      const w = res.json;
      const bad = [w.goal, w.openingAsk, w.walkAway].find((s) => FORBIDDEN_ON_CALL.test(s));
      if (bad) throw new Error(`wording says something the lender must not hear: "${bad}"`);
      return { goal: w.goal, openingAsk: w.openingAsk, walkAway: w.walkAway };
    } catch (err) {
      ctx.bus.emit({ type: 'step.completed', model: 'code', caseId: c.id, stepId: step?.id, level: 'warn', title: `Using template call wording (${(err as Error).message})` });
      return null;
    }
  }

  function nextBestText(c: Case, lead: string): { text: string; facts: Facts } {
    const others = (c.options ?? []).filter((o) => o.id !== 'move_payment');
    const facts = optionFacts(others);
    const lines = others.map((o) => `- ${optionBody(o)}`);
    const text = [lead, ...(lines.length ? ['Other ways to cover it:', ...lines] : []), 'You make the move at your bank. PacePay never moves money.'].join('\n');
    return { text, facts };
  }

  function nextDue(itemId: string): Day | undefined {
    const f = currentForecast(ctx, { days: 30 });
    return f.days.find((d) => d.items.some((i) => i.itemId === itemId))?.day;
  }

  async function stepPlanCall(c: Case, step: PlanStep): Promise<StepResult> {
    const m = chosenMove(c);
    if (!m) {
      endStep(c, 'plan_call', 'failed', 'No payment to move');
      return noCallPath(c, "I couldn't find a payment to move.");
    }
    const targets = ctx.engine.planCallTargets(h(), m.itemId, { baseChanges: ctx.store.forecastChanges(), fromDay: today() });
    if (targets.targetDay < 0) {
      doneStep(c, 'plan_call', 'No day works, even with no fee');
      return noCallPath(c, "I checked: moving the payment won't fix this, so I won't call.");
    }
    const lender = h().counterparties.find((cp) => cp.id === m.counterpartyId)?.name ?? 'the lender';
    const dueDay = nextDue(m.itemId);
    const nb = nextBestText(c, "The lender couldn't move it.");
    await ultraTurn(ctx); // the ranking just used Ultra; a back-to-back call gets a 429 and falls back to Super
    const wording = (await callWording(c, step, m, dueDay, targets, lender)) ?? templateWording(m, dueDay, targets.targetDay, nb.text);
    const callPlan: CallPlan = { ...templateWording(m, dueDay, targets.targetDay, nb.text), ...wording, targetDay: targets.targetDay, acceptableDays: targets.acceptableDays, feeLimit: targets.feeLimit };
    const neg: Negotiation = {
      id: newId('neg'),
      caseId: c.id,
      counterpartyId: m.counterpartyId ?? 'auto_lender',
      itemId: m.itemId,
      channel: 'voice',
      callPlan,
      offers: [],
      state: 'opening',
      transcript: [],
    };
    ctx.store.put('negotiations', neg);
    ctx.bus.publish({ event: 'negotiation', data: neg });
    patchCase(c.id, { negotiationId: neg.id });
    doneStep(getCase(c.id), 'plan_call', `Ask for ${formatDate(targets.targetDay, d0())}; ${targets.acceptableDays.length} day${targets.acceptableDays.length === 1 ? '' : 's'} work`);
    return 'continue';
  }

  async function stepConfirmLimits(c: Case, step: PlanStep): Promise<StepResult> {
    const neg = c.negotiationId ? ctx.store.getItem('negotiations', c.negotiationId) : undefined;
    if (!neg) {
      endStep(c, 'confirm_limits', 'failed', 'No call plan');
      return 'wait';
    }
    const prompt = limitsText({ toDay: neg.callPlan.targetDay, feeLimit: neg.callPlan.feeLimit, day0Date: d0() });
    await requestApproval(c, step, { kind: 'call_limits', prompt, choices: ['yes', 'no'] });
    moveTo(c.id, 'AWAITING_LIMITS');
    return 'wait';
  }

  function callScript(neg: Negotiation): string {
    const cp = neg.callPlan;
    const days = cp.acceptableDays.map((d) => `${d} = ${formatDate(d, d0())}`).join(', ');
    const m: MoveInfo = { itemId: neg.itemId, itemLabel: lower(itemFor(neg.itemId)?.label ?? 'payment'), toDay: neg.callPlan.targetDay, counterpartyId: neg.counterpartyId };
    const lender = h().counterparties.find((cp) => cp.id === neg.counterpartyId)?.name ?? 'the lender';
    return [
      `Opening: "${greeting(m, lender)}"`,
      `Ask: ${neg.callPlan.openingAsk}`,
      'Every offer: read it back ("So that\'s <day>, with <fee>?") and wait for the lender to confirm. Then the engine checks it.',
      'An offer that works: "Let me confirm that with Yoshua." Agree only after Yoshua approves by text (60 seconds). No answer in time: ask them to hold the offer, take a reference number, end the call.',
      `An offer that does not work: ask for a fee waiver if only the fee is the problem, otherwise ask for ${formatDate(neg.callPlan.targetDay, d0())} with no fee. Never say why.`,
      'Identity verification request: take a reference number and end the call; Yoshua will call back.',
      'Refusal: thank them and end the call. On hold more than 60 seconds: end the call politely.',
      `Walk away: ${neg.callPlan.walkAway}`,
      'Never say a balance, a limit, a floor, a paycheck date, or a reason for declining.',
      `Note for the reviewer: the plan's days are demo day numbers (day 0 = ${formatDate(0, d0())}). targetDay ${cp.targetDay} = ${formatDate(cp.targetDay, d0())}. acceptableDays: ${days}. feeLimit ${cp.feeLimit} is in cents (${formatMoney(cp.feeLimit)}), never said out loud. The engine checks every offer against these; the negotiator agrees to nothing else.`,
    ].join('\n');
  }

  async function stepSecondOpinion(c: Case, step: PlanStep): Promise<StepResult> {
    moveTo(c.id, 'REVIEWING');
    const neg = ctx.store.mustGet('negotiations', c.negotiationId!);
    try {
      const op = await runTool('second_opinion', { callPlan: neg.callPlan, rules: ctx.store.rules(), script: callScript(neg) }, ctx, scopeFor(c, step));
      const cur = getCase(c.id);
      if (!cur.review) patchCase(c.id, { review: { verdict: op.verdict, issues: op.issues, at: ctx.clock.now() } });
      if (getCase(c.id).review?.verdict === 'revise') {
        const m: MoveInfo = { itemId: neg.itemId, itemLabel: lower(itemFor(neg.itemId)?.label ?? 'payment'), toDay: neg.callPlan.targetDay, counterpartyId: neg.counterpartyId };
        const lender = h().counterparties.find((cp) => cp.id === neg.counterpartyId)?.name ?? 'the lender';
        const fixes = op.issues.map((i) => `${i.issue} Fix: ${i.fix}`);
        const revised = (await callWording(c, step, m, nextDue(neg.itemId), neg.callPlan, lender, fixes)) ?? templateWording(m, nextDue(neg.itemId), neg.callPlan.targetDay, neg.callPlan.fallbackText);
        const next = ctx.store.patch('negotiations', neg.id, { callPlan: { ...neg.callPlan, goal: revised.goal, openingAsk: revised.openingAsk, walkAway: revised.walkAway } });
        ctx.bus.publish({ event: 'negotiation', data: next });
        const r = getCase(c.id).review!;
        patchCase(c.id, { review: { ...r, revisionApplied: true } });
        doneStep(getCase(c.id), 'second_opinion', `Revised: ${op.issues.length} fix${op.issues.length === 1 ? '' : 'es'} applied`);
      } else {
        const v = getCase(c.id).review?.verdict;
        doneStep(getCase(c.id), 'second_opinion', v === 'skipped' ? 'Claude unavailable; proceeding' : 'Approved');
      }
    } catch (err) {
      // SPEC §5.4: on timeout or error, proceed and log a warn.
      patchCase(c.id, { review: { verdict: 'skipped', issues: [], at: ctx.clock.now() } });
      ctx.bus.emit({ type: 'review.result', model: 'claude-opus', caseId: c.id, stepId: step.id, level: 'warn', title: `Second opinion skipped: ${(err as Error).message}` });
      endStep(getCase(c.id), 'second_opinion', 'skipped', 'Second opinion unavailable; proceeding');
    }
    return 'continue';
  }

  async function stepPlaceCall(c: Case, step: PlanStep): Promise<StepResult> {
    assertPlaceCallAllowed(c, approvalsOf(c));
    startStep(c, 'place_call');
    await sendMessage(c, step, callingText(), {});
    const { callId } = await runTool('place_call', { negotiationId: c.negotiationId! }, ctx, scopeFor(getCase(c.id), step));
    if (!getCase(c.id).callId) patchCase(c.id, { callId });
    moveTo(c.id, 'CALLING');
    const call = ctx.store.getItem('calls', callId);
    if (call?.status === 'failed') {
      doneStep(getCase(c.id), 'place_call', "The call didn't connect; switching to text");
    } else {
      moveTo(c.id, 'NEGOTIATING');
      doneStep(getCase(c.id), 'place_call', 'The lender answered');
    }
    return 'continue';
  }

  function stepNegotiate(c: Case): StepResult {
    startStep(c, 'negotiate');
    return 'wait';
  }

  async function stepPostCallSummary(c: Case, step: PlanStep): Promise<StepResult> {
    if (getCase(c.id).state !== 'SUMMARIZING') moveTo(c.id, 'SUMMARIZING');
    const neg = c.negotiationId ? ctx.store.getItem('negotiations', c.negotiationId) : undefined;
    const callId = neg?.callId ?? c.callId;
    let sent = false;
    if (callId) {
      try {
        await runTool('post_call_summary', { callId }, ctx, scopeFor(c, step));
        sent = true;
      } catch (err) {
        ctx.bus.emit({ type: 'step.failed', model: 'nemotron-super', caseId: c.id, stepId: step.id, level: 'warn', title: `Summary tool failed (${(err as Error).message}); sending the template` });
      }
    }
    if (!sent) {
      const offer = dealOffers.get(c.id);
      if (neg?.outcome === 'deal' && offer) {
        const facts: Facts = { fee: formatMoney(offer.fee), new_day: formatDate(offer.newDay, d0()) };
        const label = itemFor(neg.itemId)?.label ?? 'Payment';
        await sendMessage(c, step, `Done. ${label} is now ${formatDate(offer.newDay, d0())} (${offer.fee ? formatMoney(offer.fee) : 'no fee'}).${neg.referenceNumber ? ` Ref ${neg.referenceNumber}.` : ''}`, facts);
      } else {
        await sendMessage(c, step, "The call ended without a change. Nothing was agreed.", {});
      }
    }
    doneStep(getCase(c.id), 'post_call_summary', neg?.outcome ? `Outcome: ${neg.outcome.replace('_', ' ')}` : undefined);
    if (neg?.outcome === 'no_deal') {
      const nb = nextBestText(getCase(c.id), "The lender wouldn't move it.");
      await inlineStep(getCase(c.id), 'send_message', 'Text Yoshua the other options', 'code', 'post_call_summary', (s) => sendMessage(getCase(c.id), s, nb.text, nb.facts));
    }
    return 'continue';
  }

  const dealOffers = new Map<string, { itemId: string; newDay: Day; fee: Cents; postsOnDay: Day }>();

  function stepUpdateForecast(c: Case): StepResult {
    startStep(c, 'update_forecast');
    if ((getCase(c.id).baseChanges ?? []).length) commit(c.id, [], { title: 'Counted the bill as paid from checking' });
    else publishForecast(ctx, { caseId: c.id });
    const f = currentForecast(ctx, { days: 30 });
    doneStep(getCase(c.id), 'update_forecast', `Lowest now ${formatMoney(f.lowest.amount)} on ${formatDate(f.lowest.day, d0())}`);
    return 'continue';
  }

  async function stepScheduleFollowup(c: Case, step: PlanStep): Promise<StepResult> {
    if (c.kind === 'cd_maturing') {
      const plan = cdFollowup(c);
      if (!plan) {
        skipStep(c, 'schedule_followup', 'Nothing to send later');
        return 'continue';
      }
      await runTool('schedule_followup', plan, ctx, scopeFor(c, step));
      doneStep(getCase(c.id), 'schedule_followup', `Steps go out ${formatDate(plan.atDay, d0())}`);
      return 'continue';
    }
    const offer = dealOffers.get(c.id);
    const neg = c.negotiationId ? ctx.store.getItem('negotiations', c.negotiationId) : undefined;
    if (!offer || neg?.outcome !== 'deal') {
      skipStep(c, 'schedule_followup', 'No new due date to remind about');
      return 'continue';
    }
    const atDay = offer.postsOnDay - 1;
    if (atDay < today()) {
      skipStep(c, 'schedule_followup', 'The payment is already due');
      return 'continue';
    }
    const item = itemFor(offer.itemId);
    const f = currentForecast(ctx, { days: 30 });
    const day = f.days.find((d) => d.day === offer.postsOnDay);
    const text = reminderText({ itemLabel: lower(item?.label ?? 'payment'), amount: Math.abs(item?.amount ?? 0), fee: offer.fee, when: 'tomorrow', balanceAfter: day?.intradayLow ?? f.lowest.amount });
    await runTool('schedule_followup', { atDay, text }, ctx, scopeFor(c, step));
    doneStep(getCase(c.id), 'schedule_followup', `Reminder set for ${formatDate(atDay, d0())}, 8:00 PM`);
    await offerPaycheckWatch(getCase(c.id));
    return 'continue';
  }

  function cdFollowup(c: Case): { atDay: Day; text: string } | null {
    const o = c.options?.find((x) => x.id === c.chosenOption);
    const info = cdAccounts.get(c.id);
    const atDay = info?.maturesOn ?? h().accounts.find((a) => a.kind === 'cd')?.maturesOn;
    if (!o || atDay === undefined || atDay < today()) return null;
    if (o.id === 'cd_payoff_card') {
      const pd = o.changes.find((ch): ch is Extract<Change, { type: 'pay_down' }> => ch.type === 'pay_down');
      const tr = o.changes.find((ch): ch is Extract<Change, { type: 'transfer' }> => ch.type === 'transfer');
      return {
        atDay,
        text: `Your CD matured today. The steps:\n1. Pay ${formatWholeDollars(pd?.amount ?? 0)} from the CD to your card.\n2. Move the other ${formatWholeDollars(tr?.amount ?? 0)} to savings.\nYou make the move at your bank. PacePay never moves money.`,
      };
    }
    return { atDay, text: 'Your CD matured today. To renew it, choose "renew" with your bank before the grace period ends. PacePay never moves money.' };
  }

  // -------------------------------------------------------------------------
  // The walk
  // -------------------------------------------------------------------------

  async function runStep(c: Case, step: PlanStep, ev: { mediaId?: string }): Promise<StepResult> {
    switch (step.kind) {
      case 'read_bill': {
        startStep(c, 'read_bill');
        if (!ev.mediaId) {
          skipStep(c, 'read_bill', 'No photo');
          return 'continue';
        }
        return stepReadBill(c, step, ev.mediaId);
      }
      case 'forecast':
        return stepForecast(c);
      case 'build_options':
        startStep(c, 'build_options');
        return stepBuildOptions(c, step);
      case 'cd_options': {
        startStep(c, 'cd_options');
        const info = cdAccounts.get(c.id);
        return stepCdOptions(c, step, info?.accountId ?? 'cd');
      }
      case 'send_options':
        startStep(c, 'send_options');
        return stepSendOptions(c, step);
      case 'await_choice':
        return stepAwaitChoice(c);
      case 'get_terms':
        startStep(c, 'get_terms');
        return stepGetTerms(c, step);
      case 'plan_call':
        startStep(c, 'plan_call');
        return stepPlanCall(c, step);
      case 'confirm_limits':
        startStep(c, 'confirm_limits');
        return stepConfirmLimits(c, step);
      case 'second_opinion':
        startStep(c, 'second_opinion');
        return stepSecondOpinion(c, step);
      case 'place_call':
        return stepPlaceCall(c, step);
      case 'negotiate':
        return stepNegotiate(c);
      case 'confirm_deal': {
        // Normally finished by the deal approval; reached here only when no deal was approved.
        skipStep(c, 'confirm_deal', 'No deal to confirm');
        return 'continue';
      }
      case 'post_call_summary':
        startStep(c, 'post_call_summary');
        return stepPostCallSummary(c, step);
      case 'update_forecast':
        return stepUpdateForecast(c);
      case 'schedule_followup':
        startStep(c, 'schedule_followup');
        return stepScheduleFollowup(c, step);
      case 'send_message':
      case 'answer_question':
        skipStep(c, step.kind, 'Nothing to send at this point');
        return 'continue';
    }
  }

  async function advance(caseId: string, ev: { mediaId?: string } = {}): Promise<void> {
    for (let guard = 0; guard < 40; guard++) {
      const c = getCase(caseId);
      if (c.state === 'DONE') return;
      const p = getPlan(c);
      if (!p) return;
      const next = p.steps.find((s) => s.status === 'pending' || s.status === 'running');
      if (!next) return finish(caseId);
      if (next.status === 'running') return; // waiting on Yoshua or the lender
      let r: StepResult;
      try {
        r = await runStep(c, next, ev);
      } catch (err) {
        endStep(getCase(caseId), next.kind, 'failed', (err as Error).message);
        ctx.bus.emit({ type: 'step.failed', model: next.model, caseId, planId: p.id, stepId: next.id, level: 'error', title: `${next.title} failed: ${(err as Error).message}` });
        if (err instanceof GateError) return;
        r = next.kind === 'read_bill' || next.kind === 'send_options' || next.kind === 'build_options' || next.kind === 'cd_options' ? 'wait' : 'continue';
      }
      if (r === 'wait') return;
    }
  }

  /** End of the plan: commit what's left and close from ADVISED or SUMMARIZING. */
  function finish(caseId: string): void {
    const c = getCase(caseId);
    if ((c.baseChanges ?? []).length) commit(caseId, [], { title: 'Counted the bill as paid from checking' });
    if (c.state === 'ADVISED' || c.state === 'SUMMARIZING') {
      moveTo(caseId, 'DONE');
      ctx.bus.emit({ type: 'step.completed', model: 'code', caseId, planId: c.planId, title: `${c.title}: done` });
    } else {
      ctx.bus.emit({ type: 'step.completed', model: 'code', caseId, planId: c.planId, level: 'warn', title: `Plan finished with the case in ${c.state}` });
    }
  }

  /** The card/savings branch, a declined limits OK, or no workable day: no call, text the advice. */
  async function noCallPath(c: Case, lead: string, opts: { skipNote?: string } = {}): Promise<StepResult> {
    skipPending(c, CALL_STEP_KINDS, opts.skipNote ?? 'No call needed');
    moveTo(c.id, 'ADVISED');
    const nb = nextBestText(getCase(c.id), lead);
    await inlineStep(getCase(c.id), 'send_message', 'Text Yoshua the other options', 'code', 'await_choice', (s) => sendMessage(getCase(c.id), s, nb.text, nb.facts));
    return 'continue';
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  async function openCase(event: Extract<AgentEvent, { type: 'BILL_PHOTO' | 'CD_MATURING' | 'SHORTFALL' }>, kind: CaseKind, title: string): Promise<Case> {
    const prev = ctx.store.currentCase();
    if (isOpen(prev)) {
      ctx.bus.emit({ type: 'event.received', model: 'code', caseId: prev.id, level: 'warn', title: `Leaving "${prev.title}" open in ${prev.state} to start a new case` });
      for (const a of approvalsOf(prev)) if (a.status === 'pending') timeoutApproval(ctx, a.id);
    }
    const caseId = newId('case');
    const planId = newId('plan');
    const c: Case = { id: caseId, title, state: 'NEW', approvalIds: [], kind, openedAt: ctx.clock.now() };
    ctx.store.put('cases', c);
    ctx.store.setCurrentCase(caseId);
    publishCase(caseId);
    const plan = await writePlan(ctx, event, { caseId, planId });
    plan.steps = plan.steps.map((s) => (s.kind === 'read_bill' ? { ...s, model: ctx.models.roleFor('vision') } : s));
    ctx.store.put('plans', plan);
    patchCase(caseId, { planId });
    const by = plan.author === 'template' ? 'the template (fallback)' : ACTOR_LABELS[plan.writtenBy ?? 'nemotron-ultra'];
    ctx.bus.emit({
      type: 'plan.created',
      model: plan.author === 'template' ? 'code' : (plan.writtenBy ?? 'nemotron-ultra'),
      caseId,
      planId,
      level: plan.author === 'template' ? 'warn' : 'info',
      title: `Plan written by ${by}: ${plan.steps.length} steps`,
      detail: { goal: plan.goal, steps: plan.steps.map((s) => ({ kind: s.kind, title: s.title, model: s.model })) },
    });
    moveTo(caseId, 'ANALYZING');
    return getCase(caseId);
  }

  function caseFor(e: { caseId?: string; approvalId?: string; negotiationId?: string }): Case | null {
    if (e.caseId) return ctx.store.getItem('cases', e.caseId) ?? null;
    if (e.approvalId) {
      const a = ctx.store.getItem('approvals', e.approvalId);
      if (a?.caseId) return ctx.store.getItem('cases', a.caseId) ?? null;
      if (a?.negotiationId) return caseFor({ negotiationId: a.negotiationId });
    }
    if (e.negotiationId) {
      const n = ctx.store.getItem('negotiations', e.negotiationId);
      if (n) return ctx.store.getItem('cases', n.caseId) ?? null;
    }
    return ctx.store.currentCase();
  }

  async function onChoice(e: Extract<AgentEvent, { type: 'CHOICE_REPLY' }>): Promise<void> {
    const c = caseFor(e);
    if (!c || c.state !== 'AWAITING_CHOICE') {
      ctx.bus.emit({ type: 'event.received', model: 'code', level: 'warn', title: `Pick "${e.text}" arrived with no case waiting for one` });
      return;
    }
    const option = c.options?.find((o) => o.id === e.optionId);
    patchCase(c.id, { chosenOption: e.optionId });
    doneStep(getCase(c.id), 'await_choice', `Yoshua picked ${e.choice}: ${option?.label.toLowerCase() ?? e.optionId}`);

    if (c.kind === 'cd_maturing') {
      moveTo(c.id, 'ADVISED');
      if (option?.changes.length) commit(c.id, [], { replace: option.changes, title: `Counted the CD plan: ${option.label.toLowerCase()}` });
      const info = cdAccounts.get(c.id);
      const maturesOn = info?.maturesOn ?? h().accounts.find((a) => a.kind === 'cd')?.maturesOn ?? today();
      await inlineStep(getCase(c.id), 'send_message', 'Confirm the pick', 'code', 'await_choice', (s) =>
        sendMessage(getCase(c.id), s, cdChoiceReplyText({ maturesOn, day0Date: d0() }), {}),
      );
      ensureStep(getCase(c.id), 'schedule_followup', 'Text the steps when the CD matures', 'code', 'send_message');
      return advance(c.id);
    }

    if (e.optionId === 'move_payment') {
      moveTo(c.id, 'PREPARING_CALL');
      return advance(c.id);
    }

    // Card or savings: no call. PacePay explains how; Yoshua makes the move (SPEC §5.2).
    skipPending(getCase(c.id), CALL_STEP_KINDS, `Yoshua picked ${option?.label.toLowerCase() ?? e.optionId}; no call`);
    moveTo(c.id, 'ADVISED');
    if (option) {
      const { text, facts } = howToText(getCase(c.id), option);
      await inlineStep(getCase(c.id), 'send_message', 'Tell Yoshua how to do it', 'code', 'await_choice', (s) => sendMessage(getCase(c.id), s, text, facts));
      commit(c.id, [], { replace: option.changes, title: `Counted the plan: ${option.label.toLowerCase()}` });
    }
    return advance(c.id);
  }

  function howToText(c: Case, o: Option): { text: string; facts: Facts } {
    const bill = getBill(c);
    // No bill (a late paycheck): the move has to land before the first day checking dips.
    const dip = bill ? null : firstDip(currentForecast(ctx, { days: 30 }));
    const by = bill ? `before the ${formatMoney(bill.amount)} ${billNoun(bill)} is paid` : dip ? `before ${formatDate(dip.day, d0())}` : 'now';
    const facts: Facts = { ...optionFacts([o]), ...(bill ? { bill_amount: formatMoney(bill.amount) } : {}) };
    if (o.id === 'card') {
      const i = o.tradeoffs.monthlyInterest ?? 0;
      return { facts, text: `Got it. Put ${bill ? `the ${formatMoney(bill.amount)} ${billNoun(bill)}` : 'it'} on your card. That's about ${formatWholeDollars(i)}/mo in interest until it's paid off.\nYou make the move. PacePay never moves money.` };
    }
    const amt = savingsAmount(o);
    const after = o.tradeoffs.savingsAfter;
    const floorNote = o.violations.includes('BELOW_SAVINGS_FLOOR') && after !== null ? ` Savings will be ${formatMoney(after)}, below your ${formatWholeDollars(h().rules.savingsFloor)} floor.` : '';
    return { facts, text: `Got it. Move ${formatWholeDollars(amt)} from savings to checking ${by}.${floorNote}\nYou make the move. PacePay never moves money.` };
  }

  async function onApprovalReply(e: Extract<AgentEvent, { type: 'APPROVAL_REPLY' }>): Promise<void> {
    const a = ctx.store.getItem('approvals', e.approvalId);
    const c = caseFor(e);
    if (!a || !c) return;
    switch (a.kind) {
      case 'bill_confirm':
        return onBillConfirm(c, e.answer);
      case 'call_limits':
        if (c.state !== 'AWAITING_LIMITS') return;
        if (e.answer === 'yes') {
          doneStep(c, 'confirm_limits', 'Yoshua said OK');
          moveTo(c.id, 'REVIEWING');
          return advance(c.id);
        }
        endStep(c, 'confirm_limits', 'done', 'Yoshua said no; no call');
        await noCallPath(getCase(c.id), "OK, I won't call.", { skipNote: 'Yoshua declined the limits' });
        return advance(c.id);
      case 'deal':
        return onDealAnswer(c, a, e.answer === 'yes' ? 'approved' : 'declined');
      default:
        return;
    }
  }

  async function onBillConfirm(c: Case, answer: 'yes' | 'no'): Promise<void> {
    const bill = getBill(c);
    if (!bill) return;
    if (answer === 'yes') {
      doneStep(c, 'read_bill', `Yoshua confirmed ${formatMoney(bill.amount)} to ${bill.merchant}`);
      return advance(c.id);
    }
    ctx.store.patch('bills', bill.id, { confirmed: false });
    await sendMessage(c, findStep(c, 'read_bill'), "OK. What's the right amount? For example: it's $700.", {});
  }

  /** The negotiator asked for the deal approval: the case waits on Yoshua (SPEC §5.3). */
  function onDealRequested(a: Approval): void {
    const c = caseFor({ caseId: a.caseId, negotiationId: a.negotiationId });
    if (!c || (c.state !== 'NEGOTIATING' && c.state !== 'TEXT_NEGOTIATION' && c.state !== 'CALLING')) return;
    if (c.state === 'CALLING') moveTo(c.id, 'NEGOTIATING');
    moveTo(c.id, 'AWAITING_APPROVAL');
    const s = findStep(getCase(c.id), 'confirm_deal');
    if (s && s.status === 'pending') startStep(getCase(c.id), 'confirm_deal');
  }

  async function onDealAnswer(c: Case, a: Approval, status: 'approved' | 'declined' | 'timeout'): Promise<void> {
    if (c.state === 'NEGOTIATING' || c.state === 'TEXT_NEGOTIATION') moveTo(c.id, 'AWAITING_APPROVAL');
    if (getCase(c.id).state !== 'AWAITING_APPROVAL') return;
    const negId = a.negotiationId ?? c.negotiationId;
    const neg = negId ? ctx.store.getItem('negotiations', negId) : undefined;
    if (!neg) return;

    // The negotiator says the line to the lender (text mode shows it in the console; the voice
    // worker polls the same idempotent answer).
    try {
      await approvalOutcome(ctx, neg.id);
    } catch (err) {
      ctx.bus.emit({ type: 'step.failed', model: 'code', caseId: c.id, level: 'warn', title: `Negotiator could not answer the lender: ${(err as Error).message}` });
    }

    if (status === 'approved') {
      moveTo(c.id, 'CONFIRMING');
      let changes: Change[] = [];
      try {
        changes = dealChanges(ctx, neg.id);
      } catch {
        changes = [];
      }
      const mv = changes.find((ch): ch is Extract<Change, { type: 'move_item' }> => ch.type === 'move_item');
      const fee = changes.find((ch): ch is Extract<Change, { type: 'add_fee' }> => ch.type === 'add_fee');
      const fresh = ctx.store.getItem('negotiations', neg.id) ?? neg;
      const offer = [...fresh.offers].reverse().find((o) => o.readBackConfirmed && (fresh.checks ?? []).some((k) => k.offerId === o.id && k.pass));
      // Gate: only an engine-passed offer is ever committed.
      if (!mv || !offer) {
        ctx.bus.emit({ type: 'step.failed', model: 'code', caseId: c.id, level: 'error', title: 'No checked offer to confirm; nothing committed' });
        return;
      }
      dealOffers.set(c.id, { itemId: offer.itemId, newDay: offer.newDay, fee: offer.fee, postsOnDay: mv.toDay });
      commit(c.id, changes, { title: `Moved the ${lower(itemFor(offer.itemId)?.label ?? 'payment')} to ${formatDate(mv.toDay, d0())}${fee ? ` with a ${formatMoney(fee.amount)} fee` : ''}` });
      doneStep(getCase(c.id), 'confirm_deal', `Yoshua approved ${formatDate(offer.newDay, d0())}, ${offer.fee ? formatMoney(offer.fee) : 'no'} fee`);
      return;
    }
    if (status === 'declined') {
      const s = findStep(getCase(c.id), 'confirm_deal');
      if (s?.status === 'running') patchStep(getCase(c.id), s.id, { status: 'pending', note: 'Yoshua declined an offer' });
      ctx.bus.emit({ type: 'step.completed', model: 'code', caseId: c.id, title: 'Yoshua declined the offer; back to negotiating' });
      const n = ctx.store.getItem('negotiations', neg.id) ?? neg;
      moveTo(c.id, n.channel === 'text' ? 'TEXT_NEGOTIATION' : 'NEGOTIATING');
      return;
    }
    moveTo(c.id, 'HOLD_REQUESTED');
    skipStep(getCase(c.id), 'confirm_deal', 'No answer in 60 s; asked the lender to hold the offer');
  }

  async function onApprovalTimeout(e: Extract<AgentEvent, { type: 'APPROVAL_TIMEOUT' }>): Promise<void> {
    const a = ctx.store.getItem('approvals', e.approvalId);
    const c = caseFor(e);
    if (!a || !c) return;
    if (!e.reminder) {
      if (a.kind === 'deal') return onDealAnswer(c, a, 'timeout');
      return;
    }
    if (a.status !== 'pending') return;
    const neg = c.negotiationId ? ctx.store.getItem('negotiations', c.negotiationId) : undefined;
    const text =
      a.kind === 'option_choice'
        ? `Still need your pick on ${lower(c.title)}. ${replyPrompt(a.optionIds?.length ?? a.choices.length)}`
        : a.kind === 'call_limits' && neg
          ? `Still need your OK before I call. ${limitsText({ toDay: neg.callPlan.targetDay, feeLimit: neg.callPlan.feeLimit, day0Date: d0() })}`
          : a.prompt;
    const facts: Facts = { prompt: a.prompt, title: c.title, ...(neg ? { fee_limit: formatWholeDollars(neg.callPlan.feeLimit) } : {}) };
    await sendMessage(c, undefined, text, facts, { unprompted: true });
  }

  async function onCallFailed(e: Extract<AgentEvent, { type: 'CALL_FAILED' }>): Promise<void> {
    const call = ctx.store.getItem('calls', e.callId);
    const negId = e.negotiationId ?? call?.negotiationId;
    const c = caseFor({ negotiationId: negId });
    if (!c || !negId) return;
    if (!['CALLING', 'NEGOTIATING', 'AWAITING_APPROVAL'].includes(c.state)) return;
    const neg = ctx.store.mustGet('negotiations', negId);
    if (neg.state === 'closed') return;
    moveTo(c.id, 'TEXT_NEGOTIATION');
    const next = ctx.store.patch('negotiations', negId, { channel: 'text' });
    ctx.bus.publish({ event: 'negotiation', data: next });
    ctx.bus.emit({ type: 'call.failed', model: 'code', caseId: c.id, level: 'warn', title: 'The call dropped. Same negotiator, same limits: negotiating by text in the lender console', detail: { callId: e.callId, negotiationId: negId, reason: e.reason } });
    try {
      openingLine(ctx, negId);
    } catch (err) {
      ctx.bus.emit({ type: 'step.failed', model: 'code', caseId: c.id, level: 'warn', title: `No opening line for the lender console: ${(err as Error).message}` });
    }
    const s = findStep(getCase(c.id), 'negotiate');
    if (s?.status === 'pending') startStep(getCase(c.id), 'negotiate');
    if (s) patchStep(getCase(c.id), s.id, { note: 'Negotiating by text' });
  }

  async function onCallEnded(e: Extract<AgentEvent, { type: 'CALL_ENDED' }>): Promise<void> {
    const call = e.callId ? ctx.store.getItem('calls', e.callId) : undefined;
    const c = caseFor({ negotiationId: e.negotiationId ?? call?.negotiationId });
    if (!c || ['SUMMARIZING', 'DONE'].includes(c.state)) return;
    if (c.state === 'CALLING') moveTo(c.id, 'NEGOTIATING');
    if (c.state === 'AWAITING_APPROVAL') {
      // The negotiation closed while the deal approval was still pending: stop waiting on it.
      for (const a of approvalsOf(getCase(c.id))) if (a.kind === 'deal' && a.status === 'pending') timeoutApproval(ctx, a.id);
    }
    moveTo(c.id, 'SUMMARIZING');
    const neg = c.negotiationId ? ctx.store.getItem('negotiations', c.negotiationId) : undefined;
    doneStep(getCase(c.id), 'negotiate', neg?.outcome ? `Outcome: ${neg.outcome.replace('_', ' ')}` : 'Ended');
    const cd = findStep(getCase(c.id), 'confirm_deal');
    if (cd && cd.status !== 'done') skipStep(getCase(c.id), 'confirm_deal', 'No deal was approved');
    // The forecast update and the night-before reminder happen even when the plan left them out.
    ensureStep(getCase(c.id), 'update_forecast', 'Update the forecast', 'engine', 'post_call_summary');
    if (dealOffers.has(c.id)) ensureStep(getCase(c.id), 'schedule_followup', 'Remind Yoshua the night before', 'code', 'update_forecast');
    return advance(c.id);
  }

  async function onBillCorrection(e: Extract<AgentEvent, { type: 'BILL_CORRECTION' }>): Promise<void> {
    const c = caseFor(e);
    if (!c || !['ANALYZING', 'OPTIONS_SENT', 'AWAITING_CHOICE'].includes(c.state)) return;
    const bill = ctx.store.patch('bills', e.billId, { amount: e.amount, source: 'correction', confirmed: false });
    for (const a of approvalsOf(c)) if (a.status === 'pending') timeoutApproval(ctx, a.id);
    moveTo(c.id, 'ANALYZING');
    patchCase(c.id, { title: caseTitle(bill), baseChanges: [billChangeFor(bill)], options: undefined, chosenOption: undefined });
    publishForecast(ctx, { caseId: c.id, title: `Corrected the bill to ${formatMoney(e.amount)}` });
    // Re-run from the forecast step.
    const p = getPlan(getCase(c.id))!;
    const from = p.steps.findIndex((s) => s.kind === 'read_bill');
    ctx.store.patch('plans', p.id, {
      steps: p.steps.map((s, i) => (i > from ? { id: s.id, kind: s.kind, title: s.title, model: s.model, status: 'pending' as const } : s)),
    });
    const rb = findStep(getCase(c.id), 'read_bill');
    if (rb) patchStep(getCase(c.id), rb.id, { status: 'done', note: `Corrected by Yoshua to ${formatMoney(e.amount)}` });
    ctx.bus.emit({ type: 'step.completed', model: 'code', caseId: c.id, title: `Yoshua corrected the bill to ${formatMoney(e.amount)}; re-running from the forecast` });
    await sendAck(getCase(c.id), rb, bill);
    return advance(c.id);
  }

  // -------------------------------------------------------------------------
  // Paycheck late: the what-if (with a watch that is on unless he says no) and the real thing
  // -------------------------------------------------------------------------

  /** Cases opened because the paycheck is late: the alert says "now that your paycheck lands Mon, Nov 16". */
  const lateCases = new Map<string, { payDay: Day; lateDay: Day }>();
  /** The paycheck watch from the last what-if; awaitingReply until his next text ("no" cancels it). */
  let paycheckWatch: { followupId: string; awaitingReply: boolean } | null = null;

  /** The first day checking dips below $0, or else under his minimum; null when it never does. */
  function firstDip(f: Forecast): Lowest | null {
    const d = f.days.find((x) => x.intradayLow < 0) ?? f.days.find((x) => x.intradayLow < h().rules.checkingFloor);
    return d ? { amount: d.intradayLow, day: d.day } : null;
  }

  function nextPaycheck(): { itemId: string; day: Day } | null {
    for (const d of currentForecast(ctx, { days: 30 }).days) {
      const i = d.items.find((x) => itemFor(x.itemId)?.kind === 'paycheck');
      if (i) return { itemId: i.itemId, day: d.day };
    }
    return null;
  }

  const COUNT_WORDS: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };

  /** The day he says it lands ("Monday", "Nov 16", "two days late"); Monday after payday by default. */
  function lateDayFrom(text: string, payDay: Day): Day {
    const ok = (d: Day) => d > payDay && d <= payDay + 13;
    const n = /\b(\d+|a|one|two|three|four|five|six|seven) (?:business )?days? late\b/i.exec(text);
    if (n) {
      const k = COUNT_WORDS[n[1]!.toLowerCase()] ?? Number(n[1]);
      if (ok(payDay + k)) return payDay + k;
    }
    const date = /\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}|\d{1,2}\/\d{1,2})\b/i.exec(text);
    if (date) {
      try {
        const d = parseDay(date[1]!, today(), d0());
        if (ok(d)) return d;
      } catch {
        /* fall through */
      }
    }
    const wd = WEEKDAY_WORD.exec(text);
    const want = wd ? wd[1]!.slice(0, 3).toLowerCase() : 'mon';
    for (let d = payDay + 1; d <= payDay + 7; d++) if (weekdayOf(d, d0()).toLowerCase() === want) return d;
    return payDay + 4;
  }

  interface PaycheckScenario {
    itemId: string;
    payDay: Day;
    lateDay: Day;
    change: Change;
    f: Forecast;
    hit: Lowest | null;
    cause?: string;
    staysNegative: boolean;
  }

  /** The engine's forecast with this paycheck landing late, on top of the current plan (any accepted deal). */
  function paycheckScenario(text: string): PaycheckScenario | null {
    const pay = nextPaycheck();
    if (!pay) return null;
    const lateDay = lateDayFrom(text, pay.day);
    const change: Change = { type: 'move_item', itemId: pay.itemId, toDay: lateDay };
    const f = ctx.engine.forecast(h(), { fromDay: today(), days: 30, changes: [...ctx.store.forecastChanges(), change] });
    const hit = firstDip(f);
    const hitDay = hit ? f.days.find((d) => d.day === hit.day) : undefined;
    const biggest = hitDay?.items.filter((i) => i.amount < 0).sort((a, b) => a.amount - b.amount)[0];
    const cause = biggest ? `the ${lower(itemFor(biggest.itemId)?.label ?? biggest.label)}` : undefined;
    const staysNegative = !!hit && hit.amount < 0 && f.days.filter((d) => d.day >= hit.day && d.day <= lateDay).every((d) => d.intradayLow < 0);
    return { itemId: pay.itemId, payDay: pay.day, lateDay, change, f, hit, cause, staysNegative };
  }

  function paycheckIntent(text: string): 'what_if' | 'late' | null {
    if (!PAYCHECK_WORDS.test(text) || !LATE_WORDS.test(text)) return null;
    if (HYPOTHETICAL.test(text)) return 'what_if';
    if (/\?\s*$/.test(text)) return null; // "Is my paycheck late?" is a question for Q&A
    return 'late';
  }

  /** A text with no case behind it (the what-if, the watch replies), through send_message's facts check. */
  async function sendCaseless(text: string, facts: Facts): Promise<void> {
    try {
      await runTool('send_message', { text, facts }, ctx, { caller: 'orchestrator', model: 'code' });
    } catch (err) {
      ctx.bus.emit({ type: 'step.failed', model: 'code', level: 'error', title: `send_message refused a text (${(err as Error).message}); sending it directly`, detail: { text, facts } });
      await sendText(ctx, text, {});
    }
  }

  function cancelPaycheckWatch(why: string): void {
    paycheckWatch = null;
    // Also any watch from before a restart (the in-memory handle is gone, the follow-up is not).
    for (const f of ctx.store.list('followups')) {
      if (f.status !== 'scheduled' || f.caseId || !/paycheck hasn't landed/.test(f.text)) continue;
      ctx.store.patch('followups', f.id, { status: 'cancelled' });
      ctx.bus.emit({ type: 'step.completed', model: 'code', title: `Stopped watching for the paycheck (${why})` });
    }
  }

  async function onPaycheckWhatIf(text: string): Promise<boolean> {
    const s = paycheckScenario(text);
    if (!s) return false;
    const floor = h().rules.checkingFloor;
    const watch = !!s.hit && s.payDay >= today();
    ctx.bus.emit({
      type: 'step.completed',
      model: 'engine',
      title: `What-if: paycheck lands ${formatDate(s.lateDay, d0())} instead of ${formatDate(s.payDay, d0())}${s.hit ? `; checking ${formatMoney(s.hit.amount)} on ${formatDate(s.hit.day, d0())}` : '; checking stays above the minimum'}`,
      detail: { change: s.change, hit: s.hit, lowest: s.f.lowest },
    });
    const text2 = paycheckWhatIfText({ payDay: s.payDay, lateDay: s.lateDay, hit: s.hit, cause: s.cause, negative: (s.hit?.amount ?? 0) < 0, checkingFloor: floor, lowest: s.f.lowest, staysNegative: s.staysNegative, watch, day0Date: d0() });
    await sendCaseless(text2, { hit: s.hit ? formatMoney(s.hit.amount) : '', floor: formatWholeDollars(floor), lowest: formatMoney(s.f.lowest.amount) });
    if (watch && s.hit) startPaycheckWatch(s, s.hit);
    return true;
  }

  /** Watch for the paycheck: a text on payday night unless he replies no. */
  function startPaycheckWatch(s: PaycheckScenario, hit: Lowest): void {
    cancelPaycheckWatch('replaced by a new watch');
    const f = ctx.store.put('followups', { id: newId('fu'), atDay: s.payDay, atTime: '20:00', text: paycheckWatchText({ hit, payDay: s.payDay, day0Date: d0() }), status: 'scheduled' });
    paycheckWatch = { followupId: f.id, awaitingReply: true };
    ctx.bus.emit({ type: 'step.completed', model: 'code', title: `Watching for the paycheck: a text ${formatDate(s.payDay, d0())}, 8:00 PM, unless he says no`, detail: { followupId: f.id } });
  }

  /**
   * Proactive, after a deal: if the new date only works because the next paycheck lands first, say so
   * and watch for it (on unless he says no). Not after a late-paycheck case, which already knows.
   */
  async function offerPaycheckWatch(c: Case): Promise<void> {
    const offer = dealOffers.get(c.id);
    if (!offer || lateCases.has(c.id)) return;
    const s = paycheckScenario('');
    if (!s?.hit || s.payDay < today() || s.payDay > offer.postsOnDay) return;
    ctx.bus.emit({ type: 'step.completed', model: 'engine', caseId: c.id, title: `The new date leans on the ${formatDate(s.payDay, d0())} paycheck: late, checking hits ${formatMoney(s.hit.amount)} on ${formatDate(s.hit.day, d0())}` });
    await sendCaseless(paycheckDependsText({ payDay: s.payDay, day0Date: d0() }), {});
    startPaycheckWatch(s, s.hit);
  }

  /** His reply to the what-if: "no" / "nah" / "don't" cancels the watch, a plain "ok" / "thanks" keeps it. */
  async function onPaycheckWatchReply(text: string): Promise<boolean> {
    if (!paycheckWatch?.awaitingReply) return false;
    const n = normalizeReply(text);
    if (WATCH_NO.test(n)) {
      cancelPaycheckWatch('Yoshua said no');
      await sendCaseless(paycheckWatchCancelledText(), {});
      return true;
    }
    paycheckWatch.awaitingReply = false;
    if (WATCH_OK.test(n) && !text.includes('?') && n.split(' ').length <= 4) {
      await sendCaseless(paycheckWatchKeptText(), {});
      return true;
    }
    return false; // anything else is a new message; the watch stays on
  }

  /** "My paycheck is going to be late, it's landing Monday": put it in the forecast and work it like a bill. */
  async function onPaycheckLate(text: string): Promise<boolean> {
    const pay = nextPaycheck();
    if (pay && pay.itemId.includes('@')) {
      await sendCaseless(`I already have your paycheck landing ${formatDate(pay.day, d0())}.`, {});
      return true;
    }
    const s = paycheckScenario(text);
    if (!s) return false;
    cancelPaycheckWatch('he says it is late');
    await sendCaseless(paycheckLateAckText({ payDay: s.payDay, lateDay: s.lateDay, day0Date: d0() }), {});
    ctx.store.addAcceptedChanges([s.change]);
    publishForecast(ctx, { title: `Moved the paycheck to ${formatDate(s.lateDay, d0())}: Yoshua says it's late` });
    if (!s.hit) {
      const floor = formatWholeDollars(h().rules.checkingFloor);
      await sendCaseless(`Checking stays above your ${floor} minimum, so there's nothing to fix.`, { floor });
      return true;
    }
    ctx.bus.emit({ type: 'event.received', model: 'code', title: `Late paycheck puts checking at ${formatMoney(s.hit.amount)} on ${formatDate(s.hit.day, d0())}: opening a case`, detail: { hit: s.hit, change: s.change } });
    const ev = { id: newId('evt'), at: ctx.clock.now(), type: 'SHORTFALL' as const, lowest: s.hit };
    const c = await openCase(ev, 'shortfall', 'Your late paycheck');
    lateCases.set(c.id, { payDay: s.payDay, lateDay: s.lateDay });
    patchCase(c.id, { acceptedChanges: [s.change] });
    await advance(c.id);
    return true;
  }

  async function onText(e: Extract<AgentEvent, { type: 'TEXT' }>): Promise<void> {
    // A typed amount after a photo PacePay couldn't read becomes the bill.
    const c = ctx.store.currentCase();
    const amount = findDollarAmount(e.text);
    if (c && c.kind === 'bill' && c.state === 'ANALYZING' && !c.billId && amount !== null) {
      const bill: Bill = { id: newId('bill'), caseId: c.id, merchant: 'your bill', amount, dueDay: today(), description: e.text, confidence: 1, confirmed: false, source: 'typed' };
      ctx.store.put('bills', bill);
      patchCase(c.id, { billId: bill.id, title: caseTitle(bill), baseChanges: [billChangeFor(bill)] });
      publishForecast(ctx, { caseId: c.id });
      const rb = findStep(getCase(c.id), 'read_bill');
      if (rb) patchStep(getCase(c.id), rb.id, { status: 'done', note: `Yoshua typed ${formatMoney(amount)}` });
      await sendAck(getCase(c.id), rb, bill);
      return advance(c.id);
    }

    if (await onPaycheckWatchReply(e.text)) return;
    const intent = paycheckIntent(e.text);
    if (intent === 'what_if' && (await onPaycheckWhatIf(e.text))) return;
    if (intent === 'late' && (await onPaycheckLate(e.text))) return;

    const caseId = c?.id;
    ctx.bus.emit({ type: 'step.started', model: 'nemotron-super', caseId, title: "Answer Yoshua's question" });
    let answer: string;
    try {
      answer = await answerQuestion(ctx, e.text, { channel: e.channel, allowNumbers: true });
    } catch (err) {
      ctx.bus.emit({ type: 'step.failed', model: 'nemotron-super', caseId, level: 'warn', title: `Q&A failed: ${(err as Error).message}` });
      answer = CANNED_QA;
    }
    await sendText(ctx, answer, { caseId, model: 'nemotron-super' });
    ctx.bus.emit({ type: 'step.completed', model: 'nemotron-super', caseId, title: "Answered Yoshua's question" });
  }

  async function handle(event: AgentEvent): Promise<void> {
    ctx.bus.emit({ type: 'event.received', model: 'code', caseId: 'caseId' in event ? event.caseId : undefined, title: `Received ${event.type}`, detail: event });
    switch (event.type) {
      case 'BILL_PHOTO': {
        const c = await openCase(event, 'bill', 'A new bill');
        return advance(c.id, { mediaId: event.mediaId });
      }
      case 'CD_MATURING': {
        const cd = h().accounts.find((a) => a.id === event.accountId);
        const c = await openCase(event, 'cd_maturing', `Your ${formatWholeDollars(cd?.balance ?? 0)} CD`);
        cdAccounts.set(c.id, { accountId: event.accountId, maturesOn: event.maturesOn });
        return advance(c.id);
      }
      case 'SHORTFALL': {
        const c = await openCase(event, 'shortfall', `Low balance on ${formatDate(event.lowest.day, d0())}`);
        return advance(c.id);
      }
      case 'CHOICE_REPLY':
        return onChoice(event);
      case 'APPROVAL_REPLY':
        return onApprovalReply(event);
      case 'APPROVAL_TIMEOUT':
        return onApprovalTimeout(event);
      case 'BILL_CORRECTION':
        return onBillCorrection(event);
      case 'TEXT':
        return onText(event);
      case 'CALL_FAILED':
        return onCallFailed(event);
      case 'CALL_ENDED':
        return onCallEnded(event);
      case 'DAILY_CHECK':
      case 'INBOUND_CALL':
        return; // the watcher and the voice API own these
    }
  }

  // The negotiator requests the deal approval from inside decide(); the case follows it here.
  ctx.bus.subscribe((ev) => {
    if (ev.event !== 'approval' || ev.data.kind !== 'deal' || ev.data.status !== 'pending') return;
    try {
      onDealRequested(ev.data);
    } catch (err) {
      ctx.bus.emit({ type: 'step.failed', model: 'code', level: 'error', title: `Could not move the case to the deal approval: ${(err as Error).message}` });
    }
  });

  return {
    async handle(event) {
      try {
        await handle(event);
      } catch (err) {
        ctx.bus.emit({ type: 'step.failed', model: 'code', level: 'error', title: `Agent failed on ${event.type}: ${(err as Error).message}`, detail: { stack: (err as Error).stack } });
      }
    },
  };
}
