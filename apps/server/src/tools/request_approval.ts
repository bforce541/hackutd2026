/**
 * Tool `request_approval` (SPEC §5.6). Implemented by: tools-code.
 * Replace notImplementedTool with defineTool('request_approval', TOOLS.request_approval.input, TOOLS.request_approval.output, async (input, ctx, scope) => ...).
 * Creates the Approval (pending, caseId from scope, optionIds/negotiationId from input), adds its id
 * to case.approvalIds, texts the prompt through ../messaging/outbox.ts sendText (deal approvals are never
 * held), publishes SSE 'approval' and emits 'approval.requested'. With timeoutMs: a timer calls
 * timeoutApproval() from ../approvals.ts, then ctx.enqueue APPROVAL_TIMEOUT { reminder: false }.
 */
import { notImplementedTool } from './registry';

export const request_approvalTool = notImplementedTool('request_approval');
