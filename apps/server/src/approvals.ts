/**
 * Approval bookkeeping shared by every stream. Implemented by: server-core.
 *
 * - tools/request_approval.ts creates the Approval (status 'pending'), texts the prompt through
 *   messaging/outbox.ts, publishes `approval`, and for a timeoutMs starts a timer that calls
 *   timeoutApproval() and then ctx.enqueue({ type: 'APPROVAL_TIMEOUT', reminder: false, ... }).
 * - messaging/router.ts (a text or coach-chat reply) and POST /api/approvals/:id (a dashboard
 *   button, routed through the router) call resolveApproval() BEFORE enqueueing CHOICE_REPLY or
 *   APPROVAL_REPLY, so the voice worker's /approval poll sees the answer at once.
 * - The agent then acts on the event; it never sets an approval's status itself.
 */
import type { Approval, ApprovalKind } from '@pacepay/shared';
import type { ToolContext } from './tools/registry';

type Ctx = Pick<ToolContext, 'store' | 'bus' | 'clock'>;

export class ApprovalStateError extends Error {
  readonly code = 'conflict';
}

/** The newest pending approval, optionally of the given kinds. */
export function pendingApproval(ctx: Ctx, kinds?: readonly ApprovalKind[]): Approval | null {
  const pending = ctx.store
    .pendingApprovals()
    .filter((a) => !kinds || kinds.includes(a.kind))
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  return pending[0] ?? null;
}

function publish(ctx: Ctx, a: Approval, title: string, level: 'info' | 'warn' = 'info'): void {
  ctx.bus.publish({ event: 'approval', data: a });
  ctx.bus.emit({ type: 'approval.resolved', model: 'code', caseId: a.caseId, title, level, detail: { approvalId: a.id, kind: a.kind, status: a.status, answer: a.answer } });
}

/**
 * Records Yoshua's answer. `answer` is 'yes' | 'no' for call_limits, deal and bill_confirm
 * (status approved / declined), or the 1-based choice as a string for option_choice (status
 * 'answered'). Throws ApprovalStateError when the approval is not pending (already answered or
 * timed out), which the HTTP layer turns into a 409.
 */
export function resolveApproval(ctx: Ctx, approvalId: string, answer: string): Approval {
  const a = ctx.store.mustGet('approvals', approvalId);
  if (a.status !== 'pending') throw new ApprovalStateError(`Approval ${approvalId} is ${a.status}, not pending`);
  let status: Approval['status'];
  if (a.kind === 'option_choice') {
    const n = Number(answer);
    if (!Number.isInteger(n) || n < 1 || n > (a.optionIds?.length ?? a.choices.length)) {
      throw new ApprovalStateError(`"${answer}" is not one of the choices for ${approvalId}`);
    }
    status = 'answered';
  } else if (answer === 'yes' || answer === 'no') {
    status = answer === 'yes' ? 'approved' : 'declined';
  } else {
    throw new ApprovalStateError(`Approval ${approvalId} needs yes or no, got "${answer}"`);
  }
  const next = ctx.store.patch('approvals', approvalId, { status, answer, resolvedAt: ctx.clock.now() });
  publish(ctx, next, `Yoshua answered ${a.kind.replace('_', ' ')}: ${answer}`);
  return next;
}

/** Marks a pending approval as timed out (no-op if it was answered first). Returns it either way. */
export function timeoutApproval(ctx: Ctx, approvalId: string): Approval {
  const a = ctx.store.mustGet('approvals', approvalId);
  if (a.status !== 'pending') return a;
  const next = ctx.store.patch('approvals', approvalId, { status: 'timeout', resolvedAt: ctx.clock.now() });
  publish(ctx, next, `No answer from Yoshua on ${a.kind.replace('_', ' ')} in time`, 'warn');
  return next;
}
