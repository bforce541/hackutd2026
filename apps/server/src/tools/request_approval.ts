/**
 * Tool `request_approval` (SPEC §5.6). Implemented by: tools-code.
 * Creates the Approval (pending, caseId from scope), adds its id to case.approvalIds, texts the
 * prompt through ../messaging/outbox.ts sendText (never unprompted, so never held), publishes SSE
 * 'approval' and emits 'approval.requested'. With timeoutMs: a timer calls timeoutApproval(), then
 * enqueues APPROVAL_TIMEOUT { reminder: false } if the approval really timed out.
 */
import { TOOLS, type Approval } from '@pacepay/shared';
import { extensionLeft, timeoutApproval } from '../approvals';
import { newId } from '../ids';
import { sendText } from '../messaging/outbox';
import { defineTool } from './registry';

/** Extra seconds a deal approval waits past its timeout, once, for a reply already on its way. */
const DEAL_GRACE_MS = 5_000;

export const request_approvalTool = defineTool('request_approval', TOOLS.request_approval.input, TOOLS.request_approval.output, async (input, ctx, scope) => {
  if (input.kind === 'option_choice' && input.optionIds && input.optionIds.length !== input.choices.length) {
    throw new Error('request_approval: optionIds must match choices one to one');
  }
  const approval: Approval = {
    id: newId('apr'),
    kind: input.kind,
    prompt: input.prompt,
    choices: input.choices,
    optionIds: input.optionIds,
    status: 'pending',
    callId: input.callId,
    caseId: scope.caseId,
    negotiationId: input.negotiationId,
    requestedAt: ctx.clock.now(),
    timeoutMs: input.timeoutMs,
  };
  ctx.store.put('approvals', approval);
  const c = scope.caseId ? ctx.store.getItem('cases', scope.caseId) : undefined;
  if (c) ctx.store.patch('cases', c.id, { approvalIds: [...c.approvalIds, approval.id] });
  ctx.bus.publish({ event: 'approval', data: approval });
  ctx.bus.emit({
    type: 'approval.requested',
    model: scope.model ?? 'code',
    caseId: scope.caseId,
    stepId: scope.stepId,
    tool: 'request_approval',
    title: `Asked Yoshua: ${input.kind.replace('_', ' ')}${input.timeoutMs ? ` (answer within ${Math.round(input.timeoutMs / 1000)} s)` : ''}`,
    detail: { approvalId: approval.id, kind: input.kind, choices: input.choices },
  });

  await sendText(ctx, input.prompt, { caseId: scope.caseId, stepId: scope.stepId, model: scope.model });

  if (input.timeoutMs) {
    let graced = false;
    const fire = (): void => {
      const before = ctx.store.getItem('approvals', approval.id);
      if (before?.status !== 'pending') return;
      // A deal approval gets a few seconds' grace once: a YES sent right at the deadline still counts.
      if (input.kind === 'deal' && !graced) {
        graced = true;
        setTimeout(fire, DEAL_GRACE_MS).unref?.();
        return;
      }
      // Yoshua is mid-reply ("hang on", a question, a reply PacePay asked about): wait for him.
      const left = extensionLeft(approval.id);
      if (left > 0) {
        setTimeout(fire, left).unref?.();
        return;
      }
      const after = timeoutApproval(ctx, approval.id);
      if (after.status !== 'timeout') return;
      ctx.enqueue({ id: newId('evt'), at: ctx.clock.now(), type: 'APPROVAL_TIMEOUT', approvalId: approval.id, caseId: approval.caseId, reminder: false });
    };
    const timer = setTimeout(fire, input.timeoutMs);
    timer.unref?.();
  }
  return { approvalId: approval.id };
});
