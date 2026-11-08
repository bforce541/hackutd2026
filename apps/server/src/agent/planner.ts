/**
 * SPEC §5.2: Ultra writes the plan, code validates it, one retry with the errors, then the
 * event's template plan (author 'template', a 'warn' event). Implemented by: agent-core.
 */
import type { AgentEvent, Plan, PlanStep, StepKind } from '@pacepay/shared';
import type { ToolContext } from '../tools/registry';

export interface PlanValidationError {
  stepIndex?: number;
  message: string;
}

/** Rules 1-3 of SPEC §5.2. Empty array = valid. */
export function validatePlan(_steps: Pick<PlanStep, 'kind' | 'model'>[], _event: AgentEvent): PlanValidationError[] {
  throw new Error('agent.validatePlan: not implemented yet');
}

/** The fallback plan for each case-starting event. */
export function templatePlan(_event: AgentEvent, _ids: { caseId: string; planId: string }): Plan {
  throw new Error('agent.templatePlan: not implemented yet');
}

export async function writePlan(_ctx: ToolContext, _event: AgentEvent, _ids: { caseId: string; planId: string }): Promise<Plan> {
  throw new Error('agent.writePlan: not implemented yet');
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
