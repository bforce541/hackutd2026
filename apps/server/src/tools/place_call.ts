/**
 * Tool `place_call` (SPEC §5.6). Implemented by: tools-code.
 * Replace notImplementedTool with defineTool('place_call', TOOLS.place_call.input, TOOLS.place_call.output, async (input, ctx, scope) => ...).
 * Gates: placeCallBlockers() from ../agent/machine.ts must return []; otherwise throw GateError.
 * Creates the Call (outbound, room roomForCall(callId), phone LENDER_PHONE, status 'dispatching'),
 * sets negotiation.callId and case.callId, publishes 'call', emits 'call.dispatched', then
 * ctx.dispatch.placeCall(). A SipCallError (or any throw) -> status 'failed', 'call.failed' event,
 * ctx.enqueue CALL_FAILED { reason: 'sip_error' }, and the tool still returns { callId, room }.
 */
import { notImplementedTool } from './registry';

export const place_callTool = notImplementedTool('place_call');
