/**
 * Claude reviews the call plan before dialing (SPEC §8.5). 30 s timeout: proceed with a 'warn'.
 * Implemented by: model-tools (tools/second_opinion.ts calls this).
 */
import { SecondOpinionSchema, type CallPlan, type Rules, type SecondOpinion } from '@pacepay/shared';
import type { ToolContext } from '../tools/registry';
import { loadPrompt } from '../prompts/load';

export interface ReviewResult {
  opinion: SecondOpinion;
  /** True when Claude was unavailable or timed out and the plan proceeds unreviewed. */
  skipped: boolean;
  reason?: string;
}

export async function reviewCallPlanDetailed(
  ctx: ToolContext,
  input: { callPlan: CallPlan; rules: Rules; script: string },
  scope: { caseId?: string; stepId?: string } = {},
): Promise<ReviewResult> {
  const prompt = loadPrompt('second-opinion', {
    call_plan_json: JSON.stringify(input.callPlan),
    rules_json: JSON.stringify(input.rules),
    script: input.script,
  });
  try {
    const res = await ctx.models.chat({
      role: 'claude',
      messages: [{ role: 'user', content: prompt }],
      json: SecondOpinionSchema,
      caseId: scope.caseId,
      stepId: scope.stepId,
      title: 'Claude reviewed the call plan',
    });
    // "Approve unless an issue is high severity" (SPEC §8.5): code enforces it.
    const verdict = res.json.issues.some((i) => i.severity === 'high') ? 'revise' : 'approve';
    return { opinion: { verdict, issues: res.json.issues }, skipped: false };
  } catch (err) {
    const reason = (err as Error).message;
    ctx.bus.emit({
      type: 'review.result',
      model: 'claude-opus',
      caseId: scope.caseId,
      stepId: scope.stepId,
      level: 'warn',
      title: `Second opinion skipped, calling anyway: ${reason}`,
    });
    return { opinion: { verdict: 'approve', issues: [] }, skipped: true, reason };
  }
}

export async function reviewCallPlan(
  ctx: ToolContext,
  input: { callPlan: CallPlan; rules: Rules; script: string },
): Promise<SecondOpinion> {
  return (await reviewCallPlanDetailed(ctx, input)).opinion;
}
