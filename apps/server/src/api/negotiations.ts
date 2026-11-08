/**
 * Routes (SPEC §4). Implemented by: negotiator.
 * Mounted at /api by app.ts. Endpoints this router owns:
 *   POST /negotiations/:id/lender (the lender console; runs the `decide` tool)
 *   GET  /negotiations/:id
 *
 * The console's first PacePay line: GET on a text negotiation that hasn't spoken yet records the
 * opening line (openingLine is idempotent), so the console always opens with it. While a deal
 * approval is pending, GET also settles it once Yoshua answers or the 60 s run out
 * (approvalOutcome is idempotent), so the console shows PacePay's next line even before the
 * agent handles APPROVAL_REPLY / APPROVAL_TIMEOUT.
 */
import { Hono } from 'hono';
import { LenderSaysRequestSchema, type LenderSaysResponse, type NegotiationResponse } from '@pacepay/shared';
import type { ServerContext } from '../context';
import { approvalOutcome, openingLine } from '../agent/negotiator';
import { runTool } from '../tools/registry';
import { HttpError, apiError, parseBody } from './http';

export function negotiationRoutes(ctx: ServerContext): Hono {
  const r = new Hono();

  r.get('/negotiations/:id', async (c) => {
    const id = c.req.param('id');
    let n = ctx.store.getItem('negotiations', id);
    if (!n) return apiError(c, 404, 'not_found', `Negotiation ${id} not found`);
    if (n.channel === 'text' && n.state !== 'closed' && !(n.transcript ?? []).some((l) => l.speaker === 'pacepay')) openingLine(ctx, id);
    if (n.state === 'awaiting_approval') await approvalOutcome(ctx, id);
    n = ctx.store.mustGet('negotiations', id);
    const body: NegotiationResponse = n;
    return c.json(body);
  });

  r.post('/negotiations/:id/lender', async (c) => {
    const id = c.req.param('id');
    const n = ctx.store.getItem('negotiations', id);
    if (!n) return apiError(c, 404, 'not_found', `Negotiation ${id} not found`);
    const call = n.callId ? ctx.store.getItem('calls', n.callId) : undefined;
    if (n.channel !== 'text' && call && ['ringing', 'active', 'holding_for_approval'].includes(call.status)) {
      throw new HttpError(409, 'conflict', 'This negotiation is on a live call; the lender console opens when the call fails');
    }
    const { text } = await parseBody(c, LenderSaysRequestSchema);
    const result = await runTool('decide', { negotiationId: id, utterance: text }, ctx, { caseId: n.caseId, caller: 'lender_console', model: ctx.models.roleFor('decide') });
    const body: LenderSaysResponse = { reply: result.say, state: result.state, awaitingApproval: result.next === 'await_approval' };
    return c.json(body);
  });

  return r;
}
