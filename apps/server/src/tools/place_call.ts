/**
 * Tool `place_call` (SPEC §5.6). Implemented by: tools-code.
 * Gates: placeCallBlockers() from ../agent/machine.ts must return []; otherwise throw GateError.
 * Creates the Call (outbound, room roomForCall(callId), phone LENDER_PHONE, 'dispatching'), sets
 * negotiation.callId and case.callId, publishes 'call', emits 'call.dispatched', then
 * ctx.dispatch.placeCall(). A SipCallError (or any throw) -> status 'failed', 'call.failed' event,
 * ctx.enqueue CALL_FAILED { reason: 'sip_error' }; the tool still returns { callId, room }.
 */
import { TOOLS, type Approval, type Call } from '@pacepay/shared';
import { GateError, placeCallBlockers } from '../agent/machine';
import { env } from '../env';
import { newId } from '../ids';
import { SipCallError, roomForCall } from '../voice/dispatch';
import { defineTool } from './registry';

export const place_callTool = defineTool('place_call', TOOLS.place_call.input, TOOLS.place_call.output, async (input, ctx, scope) => {
  const neg = ctx.store.mustGet('negotiations', input.negotiationId);
  const c = ctx.store.mustGet('cases', neg.caseId);
  const approvals = c.approvalIds.map((id) => ctx.store.getItem('approvals', id)).filter((a): a is Approval => !!a);
  const blockers = placeCallBlockers(c, approvals);
  if (blockers.length) throw new GateError(`place_call refused: ${blockers.join('; ')}`);

  const callId = newId('call');
  const room = roomForCall(callId);
  const phone = env('LENDER_PHONE') ?? '';
  const call: Call = {
    id: callId,
    direction: 'outbound',
    counterpartyId: neg.counterpartyId,
    phone,
    room,
    status: 'dispatching',
    negotiationId: neg.id,
    transcript: [],
    startedAt: ctx.clock.now(),
  };
  ctx.store.put('calls', call);
  const negotiation = ctx.store.patch('negotiations', neg.id, { callId });
  ctx.store.patch('cases', c.id, { callId });
  ctx.bus.publish({ event: 'negotiation', data: negotiation });
  ctx.bus.publish({ event: 'call', data: call });
  ctx.bus.emit({
    type: 'call.dispatched',
    model: scope.model ?? 'code',
    caseId: c.id,
    stepId: scope.stepId,
    tool: 'place_call',
    title: 'Dialing the lender',
    detail: { callId, room, negotiationId: neg.id },
  });

  try {
    if (!phone) throw new SipCallError('LENDER_PHONE is not set');
    await ctx.dispatch.placeCall({ callId, room, phone });
  } catch (err) {
    const now = ctx.store.getItem('calls', callId);
    // The voice worker may already have reported the failure or an end; do not report twice.
    if (now && now.status !== 'failed' && now.status !== 'ended') {
      const failed = ctx.store.patch('calls', callId, { status: 'failed', endedAt: ctx.clock.now() });
      const sipStatus = err instanceof SipCallError ? err.sipStatus : undefined;
      ctx.bus.publish({ event: 'call', data: failed });
      ctx.bus.emit({
        type: 'call.failed',
        model: scope.model ?? 'code',
        caseId: c.id,
        stepId: scope.stepId,
        level: 'error',
        title: `The call did not connect: ${(err as Error).message}`,
        detail: { callId, sipStatus },
      });
      ctx.enqueue({ id: newId('evt'), at: ctx.clock.now(), type: 'CALL_FAILED', callId, negotiationId: neg.id, reason: 'sip_error', sipStatus });
    }
  }
  return { callId, room };
});
