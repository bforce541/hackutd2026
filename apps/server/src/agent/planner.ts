/**
 * SPEC §5.2: Ultra writes the plan, code validates it, one retry with the errors, then the
 * event's template plan (author 'template', a 'warn' event). Implemented by: agent-core.
 *
 * The model client already falls back from Ultra to Super on a timeout or error (SPEC §5.4), so
 * writePlan makes at most two planner calls: the first, and one retry carrying the validation
 * errors. Anything else (both invalid, or the model unavailable) gives the template plan.
 */
import {
  ACTOR_LABELS,
  PlannerOutputSchema,
  STEP_KINDS,
  STEP_MODELS,
  formatDate,
  formatMoney,
  type AgentEvent,
  type ModelRole,
  type Plan,
  type PlanStep,
  type StepKind,
} from '@pacepay/shared';
import type { ToolContext } from '../tools/registry';
import { loadPrompt } from '../prompts/load';
import { currentForecast } from '../forecast';
import { newId } from '../ids';

export interface PlanValidationError {
  stepIndex?: number;
  message: string;
}

/** The call steps the orchestrator skips when Yoshua picks card or savings (SPEC §5.2). */
export const CALL_STEP_KINDS: readonly StepKind[] = [
  'get_terms',
  'plan_call',
  'confirm_limits',
  'second_opinion',
  'place_call',
  'negotiate',
  'confirm_deal',
  'post_call_summary',
];

type CaseEvent = Extract<AgentEvent, { type: 'BILL_PHOTO' | 'CD_MATURING' | 'SHORTFALL' }>;

/** The steps a plan for this event must contain, so every branch the case can take has a step. */
const CALL_CHAIN: StepKind[] = ['plan_call', 'confirm_limits', 'second_opinion', 'place_call', 'negotiate', 'confirm_deal', 'post_call_summary'];
export function requiredKinds(event: AgentEvent): StepKind[] {
  switch (event.type) {
    case 'BILL_PHOTO':
      return ['read_bill', 'forecast', 'build_options', 'send_options', 'await_choice', ...CALL_CHAIN, 'update_forecast', 'schedule_followup'];
    case 'SHORTFALL':
      return ['build_options', 'send_options', 'await_choice', ...CALL_CHAIN, 'update_forecast', 'schedule_followup'];
    case 'CD_MATURING':
      return ['cd_options', 'send_options', 'await_choice'];
    default:
      return [];
  }
}

/** Kinds that must come before another kind when both are in the plan: [before, after, why]. */
const ORDER: [StepKind, StepKind, string][] = [
  ['await_choice', 'place_call', 'place_call comes after await_choice'],
  ['plan_call', 'confirm_limits', 'confirm_limits comes after plan_call'],
  ['confirm_limits', 'second_opinion', 'confirm_limits comes before second_opinion'],
  ['confirm_limits', 'place_call', 'confirm_limits comes before place_call'],
  ['second_opinion', 'place_call', 'second_opinion comes before place_call'],
  ['negotiate', 'confirm_deal', 'confirm_deal comes after negotiate'],
  ['place_call', 'post_call_summary', 'post_call_summary comes after place_call'],
  // The order the orchestrator can carry out (reading before deciding, options before asking).
  ['read_bill', 'build_options', 'read_bill comes before build_options'],
  ['build_options', 'send_options', 'build_options comes before send_options'],
  ['cd_options', 'send_options', 'cd_options comes before send_options'],
  ['send_options', 'await_choice', 'send_options comes before await_choice'],
  ['await_choice', 'get_terms', 'get_terms comes after await_choice (only the call option needs terms)'],
  ['await_choice', 'plan_call', 'plan_call comes after await_choice'],
  ['get_terms', 'plan_call', 'get_terms comes before plan_call'],
  ['place_call', 'negotiate', 'negotiate comes after place_call'],
  ['read_bill', 'forecast', 'forecast comes after read_bill'],
  ['forecast', 'send_options', 'forecast comes before send_options'],
  ['post_call_summary', 'update_forecast', 'update_forecast comes after post_call_summary'],
  ['update_forecast', 'schedule_followup', 'schedule_followup comes after update_forecast'],
];

/** Kinds that need a phone call; none of them may appear in a CD or question plan. */
const NO_CALL_KINDS: StepKind[] = ['get_terms', 'plan_call', 'confirm_limits', 'second_opinion', 'place_call', 'negotiate', 'confirm_deal', 'post_call_summary'];

/** Rules 1-3 of SPEC §5.2 (plus coverage and order rules the orchestrator needs). Empty array = valid. */
export function validatePlan(steps: Pick<PlanStep, 'kind' | 'model'>[], event: AgentEvent): PlanValidationError[] {
  const errors: PlanValidationError[] = [];
  if (steps.length === 0) return [{ message: 'The plan has no steps' }];

  // Rule 1: known kinds, and each step's model matches the table.
  const seen = new Map<StepKind, number>();
  steps.forEach((s, i) => {
    if (!(STEP_KINDS as readonly string[]).includes(s.kind)) {
      errors.push({ stepIndex: i, message: `Unknown step kind "${s.kind}"` });
      return;
    }
    const allowed = STEP_MODELS[s.kind];
    if (!allowed.includes(s.model)) {
      errors.push({ stepIndex: i, message: `Step ${i + 1} (${s.kind}) must run on ${allowed.join(' or ')}, not ${s.model}` });
    }
    if (seen.has(s.kind) && s.kind !== 'send_message') {
      errors.push({ stepIndex: i, message: `Step kind ${s.kind} appears twice (steps ${seen.get(s.kind)! + 1} and ${i + 1})` });
    }
    if (!seen.has(s.kind)) seen.set(s.kind, i);
  });

  // Rule 2: ordering gates. The confirm_limits gate also means a call plan must have one.
  const has = (k: StepKind) => seen.has(k);
  if (has('place_call')) {
    for (const k of ['await_choice', 'plan_call', 'confirm_limits', 'second_opinion'] as StepKind[]) {
      if (!has(k)) errors.push({ message: `A plan with place_call must include ${k}` });
    }
  }
  if (has('confirm_deal') && !has('negotiate')) errors.push({ message: 'confirm_deal needs a negotiate step before it' });
  if (has('post_call_summary') && !has('place_call')) errors.push({ message: 'post_call_summary needs a place_call step before it' });
  for (const [before, after, why] of ORDER) {
    if (has(before) && has(after) && seen.get(before)! > seen.get(after)!) {
      errors.push({ stepIndex: seen.get(after), message: why });
    }
  }

  // Rule 3: no call when it isn't needed.
  if (event.type === 'CD_MATURING' || event.type === 'TEXT') {
    for (const k of NO_CALL_KINDS) if (has(k)) errors.push({ stepIndex: seen.get(k), message: `A ${event.type} plan never includes ${k} (no call)` });
  }

  // Coverage: every branch of this event has its step.
  for (const k of requiredKinds(event)) {
    if (!has(k)) errors.push({ message: `This ${event.type} plan must include a ${k} step` });
  }
  if (event.type !== 'BILL_PHOTO' && has('read_bill')) errors.push({ stepIndex: seen.get('read_bill'), message: 'read_bill only belongs in a BILL_PHOTO plan' });
  return errors;
}

// ---------------------------------------------------------------------------
// Template plans
// ---------------------------------------------------------------------------

type Draft = [StepKind, string, ModelRole];

/** UI.md › Activity tab: the repair plan's 15 steps. */
const BILL_TEMPLATE: Draft[] = [
  ['read_bill', 'Read the repair quote', 'nemotron-vision'],
  ['forecast', 'Check the week if paid today', 'engine'],
  ['build_options', 'Compare card, savings and moving a payment', 'engine'],
  ['send_options', 'Text Yoshua the options and a chart', 'nemotron-super'],
  ['await_choice', "Wait for Yoshua's pick", 'code'],
  ['get_terms', "Pull the auto loan's terms", 'nemotron-super'],
  ['plan_call', 'Plan the call', 'nemotron-ultra'],
  ['confirm_limits', 'Check the limits with Yoshua', 'code'],
  ['second_opinion', 'Second opinion on the call plan', 'claude-opus'],
  ['place_call', 'Call the lender', 'code'],
  ['negotiate', 'Negotiate the due date', 'nemotron-super'],
  ['confirm_deal', "Get Yoshua's OK on the deal", 'code'],
  ['post_call_summary', 'Text Yoshua the summary', 'nemotron-super'],
  ['update_forecast', 'Update the forecast', 'engine'],
  ['schedule_followup', 'Remind Yoshua the night before', 'code'],
];

const SHORTFALL_TEMPLATE: Draft[] = [
  ['forecast', 'Find the low point and its causes', 'engine'],
  ['build_options', 'Compare savings and moving a payment', 'engine'],
  ['send_options', 'Text Yoshua the options and a chart', 'nemotron-super'],
  ['await_choice', "Wait for Yoshua's pick", 'code'],
  ['get_terms', "Pull the lender's terms", 'nemotron-super'],
  ['plan_call', 'Plan the call', 'nemotron-ultra'],
  ['confirm_limits', 'Check the limits with Yoshua', 'code'],
  ['second_opinion', 'Second opinion on the call plan', 'claude-opus'],
  ['place_call', 'Call the lender', 'code'],
  ['negotiate', 'Negotiate the due date', 'nemotron-super'],
  ['confirm_deal', "Get Yoshua's OK on the deal", 'code'],
  ['post_call_summary', 'Text Yoshua the summary', 'nemotron-super'],
  ['update_forecast', 'Update the forecast', 'engine'],
  ['schedule_followup', 'Remind Yoshua the night before', 'code'],
];

const CD_TEMPLATE: Draft[] = [
  ['cd_options', 'Compare renewing the CD and paying off the card', 'engine'],
  ['send_options', 'Text Yoshua the CD options', 'nemotron-super'],
  ['await_choice', "Wait for Yoshua's pick", 'code'],
  ['send_message', 'Confirm the pick', 'code'],
  ['schedule_followup', 'Text the steps when the CD matures', 'code'],
];

function goalFor(event: AgentEvent): string {
  switch (event.type) {
    case 'BILL_PHOTO':
      return "Cover the bill without going below Yoshua's floor";
    case 'CD_MATURING':
      return 'Put the maturing CD to its best use';
    case 'SHORTFALL':
      return "Keep checking above Yoshua's floor";
    default:
      return `Handle ${event.type}`;
  }
}

function toSteps(drafts: { kind: StepKind; title: string; model: ModelRole }[]): PlanStep[] {
  return drafts.map((d) => ({ id: newId('step'), kind: d.kind, title: d.title, model: d.model, status: 'pending' }));
}

/** The fallback plan for each case-starting event. */
export function templatePlan(event: AgentEvent, ids: { caseId: string; planId: string }): Plan {
  const drafts = event.type === 'BILL_PHOTO' ? BILL_TEMPLATE : event.type === 'CD_MATURING' ? CD_TEMPLATE : SHORTFALL_TEMPLATE;
  return {
    id: ids.planId,
    caseId: ids.caseId,
    eventId: event.id,
    goal: goalFor(event),
    author: 'template',
    writtenBy: 'code',
    steps: toSteps(drafts.map(([kind, title, model]) => ({ kind, title, model }))),
  };
}

// ---------------------------------------------------------------------------
// Ultra writes the plan
// ---------------------------------------------------------------------------

/** Pins the roles the runtime actually uses (read_bill runs on the VL Super in NVIDIA mode). */
function runtimeModel(ctx: ToolContext, kind: StepKind, model: ModelRole): ModelRole {
  if (kind === 'read_bill') return ctx.models.roleFor('vision');
  return model;
}

function modelTable(ctx: ToolContext): string {
  return STEP_KINDS.map((k) => {
    const allowed = k === 'read_bill' ? [ctx.models.roleFor('vision')] : STEP_MODELS[k];
    return `${k}: ${allowed.join(' or ')}`;
  }).join('; ');
}

function describeEvent(ctx: ToolContext, event: CaseEvent): string {
  const h = ctx.store.household();
  switch (event.type) {
    case 'BILL_PHOTO':
      return `BILL_PHOTO: Yoshua texted a photo of a bill (media ${event.mediaId}) with no question. Nothing is known about it until read_bill runs.`;
    case 'CD_MATURING': {
      const cd = h.accounts.find((a) => a.id === event.accountId);
      return `CD_MATURING: the ${cd?.name ?? 'CD'} (${formatMoney(cd?.balance ?? 0)}) matures ${formatDate(event.maturesOn, h.day0Date)}. PacePay texts Yoshua unprompted.`;
    }
    case 'SHORTFALL':
      return `SHORTFALL: the daily check found checking going to ${formatMoney(event.lowest.amount)} on ${formatDate(event.lowest.day, h.day0Date)}, below $0, with no open case.`;
  }
}

function snapshot(ctx: ToolContext): string {
  const h = ctx.store.household();
  const today = ctx.clock.today();
  const lines = [`Today: ${formatDate(today, h.day0Date)} (demo day ${today}).`, 'Accounts:'];
  for (const a of h.accounts) {
    lines.push(`- ${a.name} (${a.kind}${a.reference ? `, ${a.reference}` : ''}${a.offLimits ? ', off-limits' : ''}): ${formatMoney(a.balance)}`);
  }
  const r = h.rules;
  lines.push(`Rules: keep ${formatMoney(r.checkingFloor)} in checking, ${formatMoney(r.savingsFloor)} in savings, at most ${formatMoney(r.feeLimit)} in fees, off-limits: ${r.offLimitsAccountIds.join(', ') || 'none'}.`);
  try {
    const f = currentForecast(ctx, { days: 30 });
    lines.push(`Forecast (checking, 30 days): lowest ${formatMoney(f.lowest.amount)} on ${formatDate(f.lowest.day, h.day0Date)}.`);
  } catch {
    lines.push('Forecast: unavailable.');
  }
  const movable = h.scheduled.filter((s) => s.movable).map((s) => `${s.label} (${s.counterpartyId ?? 'no counterparty'})`);
  lines.push(`Payments a lender call can move: ${movable.join(', ') || 'none'}.`);
  const open = ctx.store.currentCase();
  lines.push(`Open case: ${open && open.state !== 'DONE' ? `${open.title} (${open.state})` : 'none'}.`);
  return lines.join('\n');
}

function eventRules(event: CaseEvent): string {
  const req = requiredKinds(event);
  const call = event.type === 'CD_MATURING' ? ' This event never needs a call: include none of plan_call, confirm_limits, second_opinion, place_call, negotiate, confirm_deal, post_call_summary, get_terms.' : ' Yoshua may pick the option where PacePay calls the lender, so include the whole call chain after await_choice.';
  return `This plan must include these step kinds: ${req.join(', ')}.${call}`;
}

/**
 * build.nvidia.com rate-limits Ultra per key: only a few requests a minute with a small burst, and a
 * 429 comes back in ~0.2 s and clears a few seconds later. A case calls Ultra back to back (the plan,
 * the option ranking, then plan_call a few seconds after Yoshua's pick), and the model client's one
 * retry goes straight to Super, so the third call hit a 429 and fell back. Waiting until the last
 * Ultra call in the feed is ULTRA_GAP_MS old keeps the first try on Ultra; the Super fallback stays
 * as the safety net. A no-op when the planner job does not run on Ultra.
 */
export const ULTRA_GAP_MS = 12_000;
export async function ultraTurn(ctx: Pick<ToolContext, 'models' | 'store'>): Promise<void> {
  if (ctx.models.roleFor('planner') !== 'nemotron-ultra') return;
  const log = ctx.store.activity();
  const now = Date.now();
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!;
    const at = Date.parse(e.at);
    if (!(at > now - ULTRA_GAP_MS)) return; // the feed is in time order: nothing recent enough
    if (e.type === 'model.called' && e.model === 'nemotron-ultra') {
      await new Promise((r) => setTimeout(r, at + ULTRA_GAP_MS - now));
      return;
    }
  }
}

function format(errors: PlanValidationError[]): string {
  return errors.map((e) => `- ${e.stepIndex !== undefined ? `step ${e.stepIndex + 1}: ` : ''}${e.message}`).join('\n');
}

export async function writePlan(ctx: ToolContext, event: AgentEvent, ids: { caseId: string; planId: string }): Promise<Plan> {
  if (event.type !== 'BILL_PHOTO' && event.type !== 'CD_MATURING' && event.type !== 'SHORTFALL') return templatePlan(event, ids);
  const system = loadPrompt('planner', {
    person_name: ctx.store.household().person.name,
    step_kinds: STEP_KINDS.join(', '),
    model_table: modelTable(ctx),
  });
  const user = `EVENT\n${describeEvent(ctx, event)}\n\nSNAPSHOT\n${snapshot(ctx)}\n\n${eventRules(event)}\nReturn {"goal": string, "steps": [{"kind", "title", "model"}]}.`;
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  let lastErrors: PlanValidationError[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt === 0) await ultraTurn(ctx);
      const res = await ctx.models.chat({
        role: 'planner',
        messages,
        json: PlannerOutputSchema,
        caseId: ids.caseId,
        title: attempt === 0 ? `Wrote the plan for ${event.type}` : `Rewrote the plan for ${event.type} after validation`,
      });
      const out = res.json;
      const errors = validatePlan(out.steps, event);
      if (errors.length === 0) {
        return {
          id: ids.planId,
          caseId: ids.caseId,
          eventId: event.id,
          goal: out.goal,
          author: 'nemotron-ultra',
          writtenBy: res.modelRole,
          steps: toSteps(out.steps.map((s) => ({ ...s, model: runtimeModel(ctx, s.kind, s.model) }))),
        };
      }
      lastErrors = errors;
      ctx.bus.emit({
        type: 'plan.created',
        model: 'code',
        caseId: ids.caseId,
        planId: ids.planId,
        level: 'warn',
        title: `Plan from ${ACTOR_LABELS[res.modelRole]} failed validation (${errors.length} issue${errors.length === 1 ? '' : 's'})${attempt === 0 ? '; asking once more' : ''}`,
        detail: { errors, steps: out.steps },
      });
      messages.push({ role: 'assistant', content: JSON.stringify(out) });
      messages.push({ role: 'user', content: `The plan failed validation:\n${format(errors)}\nFix every issue and return the whole plan again.` });
    } catch (err) {
      lastErrors = [{ message: (err as Error).message }];
      break;
    }
  }

  ctx.bus.emit({
    type: 'plan.created',
    model: 'code',
    caseId: ids.caseId,
    planId: ids.planId,
    level: 'warn',
    title: `Using the template plan for ${event.type}`,
    detail: { errors: lastErrors },
  });
  return templatePlan(event, ids);
}
