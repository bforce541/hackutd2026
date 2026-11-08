/**
 * Tool `second_opinion` (SPEC §5.6). Implemented by: model-tools.
 * Claude reviews the call plan and script (agent/secondOpinion.ts), emits review.result and
 * stores the result on the case (case.review) for the place_call gate. When Claude is unavailable
 * or times out the plan proceeds: the tool returns 'approve' and case.review.verdict is 'skipped'.
 */
import { TOOLS } from '@pacepay/shared';
import { defineTool } from './registry';
import { reviewCallPlanDetailed } from '../agent/secondOpinion';

export const second_opinionTool = defineTool('second_opinion', TOOLS.second_opinion.input, TOOLS.second_opinion.output, async (input, ctx, scope) => {
  const { opinion, skipped } = await reviewCallPlanDetailed(ctx, input, scope);
  const at = ctx.clock.now();
  if (scope.caseId && ctx.store.getItem('cases', scope.caseId)) {
    ctx.store.patch('cases', scope.caseId, { review: { verdict: skipped ? 'skipped' : opinion.verdict, issues: opinion.issues, at } });
  }
  if (!skipped) {
    const high = opinion.issues.filter((i) => i.severity === 'high').length;
    ctx.bus.emit({
      type: 'review.result',
      model: 'claude-opus',
      caseId: scope.caseId,
      stepId: scope.stepId,
      level: opinion.verdict === 'revise' ? 'warn' : 'info',
      title: opinion.verdict === 'approve' ? `Claude approved the call plan${opinion.issues.length ? ` (${opinion.issues.length} minor note${opinion.issues.length === 1 ? '' : 's'})` : ''}` : `Claude asked for ${high} fix${high === 1 ? '' : 'es'} to the call plan`,
      detail: opinion,
    });
  }
  return opinion;
});
