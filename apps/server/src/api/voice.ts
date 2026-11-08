/**
 * Routes (SPEC §4). Implemented by: voice.
 * Mounted at /api by app.ts. Endpoints this router owns:
 *   GET  /voice/calls/:id/brief (allowlist only: no balances, limits or reasons)
 *   POST /voice/calls/:id/decide (runTool('decide', { negotiationId: call.negotiationId, utterance }, ctx, { caller: 'voice' }))
 *   POST /voice/calls/:id/approval (agent/negotiator.ts approvalOutcome(ctx, call.negotiationId))
 *   POST /voice/calls/:id/events -> 204 (answered: status 'active', 'call.answered', publish 'call' (case state is the agent's);
 *        transcript: append to Call.transcript, 'call.transcript', publish 'call'; ended: status 'ended',
 *        endedAt, then ctx.enqueue CALL_ENDED if the negotiation has an outcome, else CALL_FAILED
 *        { reason: 'ended_without_outcome' }; failed: CALL_FAILED { reason: 'sip_error', sipStatus })
 *   POST /voice/inbound (create the Call: direction 'inbound', room from the body, status 'active';
 *        requirePin true; an unknown caller still gets a callId and the "account holder" line;
 *        ctx.enqueue INBOUND_CALL)
 *   POST /voice/calls/:id/verify-pin (caller ID === CUSTOMER_PHONE and digits === INBOUND_PIN; three
 *        failures -> say the goodbye line; sets pinVerified)
 *   POST /voice/calls/:id/ask (agent/qa.ts answerQuestion(ctx, question, { channel: 'voice',
 *        allowNumbers: call.pinVerified === true }))
 *   Every route uses the localOnly middleware from ./http.
 * Validate bodies with the request schemas in @pacepay/shared (parseBody), return the
 * response types from @pacepay/shared/api, and errors with apiError().
 */
import { Hono } from 'hono';
import type { ServerContext } from '../context';

export function voiceRoutes(_ctx: ServerContext): Hono {
  const r = new Hono();
  return r;
}
