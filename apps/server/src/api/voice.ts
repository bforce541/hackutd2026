/**
 * Routes (SPEC §4). Implemented by: voice.
 * Mounted at /api by app.ts. Endpoints this router owns:
 *   GET  /voice/calls/:id/brief (allowlist only: no balances, limits or reasons)
 *   POST /voice/calls/:id/decide (runTool('decide', { negotiationId: call.negotiationId, utterance }, ctx, { caller: 'voice' }))
 *   POST /voice/calls/:id/approval (agent/negotiator.ts approvalOutcomeForCall(ctx, call.negotiationId): the
 *        outcome line comes back once; if decide already said it on the call, `say` is empty)
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
import {
  VoiceAskRequestSchema,
  VoiceCallEventRequestSchema,
  VoiceDecideRequestSchema,
  VoiceInboundRequestSchema,
  VoiceVerifyPinRequestSchema,
  formatShortDate,
  formatWeekdayLong,
  type Call,
  type VoiceBriefResponse,
  type VoiceInboundResponse,
} from '@pacepay/shared';
import type { ServerContext } from '../context';
import { env } from '../env';
import { newId, nowIso } from '../ids';
import { runTool } from '../tools/registry';
import { accountReference, approvalOutcomeForCall, greetingLine } from '../agent/negotiator';
import { answerQuestion } from '../agent/qa';
import { roomForCall } from '../voice/dispatch';
import { apiError, HttpError, localOnly, parseBody } from './http';

export const ACCOUNT_HOLDER_LINE = 'I can only discuss account details with the account holder.';
export const INBOUND_GREETING = 'Hi, this is PacePay, Yoshua\'s money assistant. For your security, please say your four-digit PIN.';
const PIN_OK_LINE = 'Thanks, you are verified. What would you like to know?';
const PIN_RETRY_LINE = 'That PIN did not match. Please say it again.';
const PIN_GOODBYE_LINE = 'I could not verify the PIN, so I have to end the call. Goodbye.';
const MAX_PIN_TRIES = 3;
/** If the model forgets end_call after the goodbye line, hang up anyway. */
const PIN_HANGUP_DELAY_MS = 15_000;

const digitsOf = (s: string) => s.replace(/\D/g, '');
/** Same phone number regardless of formatting: compare the last ten digits. */
const samePhone = (a: string, b: string) => {
  const x = digitsOf(a).slice(-10);
  const y = digitsOf(b).slice(-10);
  return x.length === 10 && x === y;
};

export function voiceRoutes(ctx: ServerContext): Hono {
  const r = new Hono();
  r.use('*', localOnly);
  const { store, bus } = ctx;
  const pinFailures = new Map<string, number>();

  function getCall(id: string): Call {
    const call = store.getItem('calls', id);
    if (!call) throw new HttpError(404, 'not_found', `No call ${id}`);
    return call;
  }

  function negotiationIdOf(call: Call): string {
    if (!call.negotiationId) throw new HttpError(400, 'bad_request', 'This call has no negotiation');
    return call.negotiationId;
  }

  function publishCall(id: string): Call {
    const call = store.mustGet('calls', id);
    bus.publish({ event: 'call', data: call });
    return call;
  }

  function caseIdOf(call: Call): string | undefined {
    return call.negotiationId ? store.getItem('negotiations', call.negotiationId)?.caseId : undefined;
  }

  function isOver(call: Call): boolean {
    return call.status === 'ended' || call.status === 'failed';
  }

  function inboundGreeting(call: Call): string {
    const known = samePhone(call.phone, env('CUSTOMER_PHONE') ?? '');
    return known ? INBOUND_GREETING : ACCOUNT_HOLDER_LINE;
  }

  // The brief: an allowlist. Nothing here reads a balance, a limit or a reason.
  r.get('/voice/calls/:id/brief', (c) => {
    const call = getCall(c.req.param('id') ?? '');
    if (call.direction === 'inbound') {
      const body: VoiceBriefResponse = {
        direction: 'inbound',
        greeting: inboundGreeting(call),
        goal: 'Verify the caller with the PIN, then answer their questions.',
        personName: 'Yoshua',
        accountReference: '',
      };
      return c.json(body);
    }
    // Built by code from an allowlist: the lender's name, the loan's reference ("ending 4417"), and
    // the ask (the target day with no fee). Never the plan's model-written wording, a balance, the fee
    // limit, the floors, or a reason. The greeting ends with the ask so the call opens with it.
    const neg = call.negotiationId ? store.getItem('negotiations', call.negotiationId) : undefined;
    const household = store.household();
    // A payment already moved once is 'auto_payment@6': fall back to its base id for the label.
    const item = neg ? household.scheduled.find((s) => s.id === neg.itemId || s.id === neg.itemId.split(/[@#:]/)[0]) : undefined;
    const counterparty = household.counterparties.find((p) => p.id === (neg?.counterpartyId ?? call.counterpartyId));
    const ref = neg ? accountReference(ctx, neg) : 'account';
    const about = `the ${ref}`;
    const reference = /ending \d+/.exec(ref)?.[0] ?? '';
    const greeting = neg
      ? greetingLine(ctx, neg, 'voice')
      : `Hi, I'm PacePay, an AI assistant calling on behalf of Yoshua, with Yoshua's permission, about ${about}. This call is transcribed.`;
    const goal =
      neg && item
        ? `Ask to move this month's ${item.label.toLowerCase()} to ${formatWeekdayLong(neg.callPlan.targetDay, household.day0Date)}, ${formatShortDate(neg.callPlan.targetDay, household.day0Date)}, with no fee.`
        : 'Ask about the account';
    const body: VoiceBriefResponse = {
      direction: 'outbound',
      greeting,
      goal,
      personName: 'Yoshua',
      accountReference: reference,
      ...(counterparty ? { counterpartyName: counterparty.name } : {}),
    };
    return c.json(body);
  });

  r.post('/voice/calls/:id/decide', async (c) => {
    const call = getCall(c.req.param('id') ?? '');
    const { utterance } = await parseBody(c, VoiceDecideRequestSchema);
    const out = await runTool(
      'decide',
      { negotiationId: negotiationIdOf(call), utterance },
      ctx,
      { caller: 'voice', model: 'nemotron-nano', caseId: caseIdOf(call) },
    );
    return c.json(out);
  });

  r.post('/voice/calls/:id/approval', async (c) => {
    const call = getCall(c.req.param('id') ?? '');
    const out = await approvalOutcomeForCall(ctx, negotiationIdOf(call));
    if (!isOver(call)) {
      const status = out.status === 'pending' ? 'holding_for_approval' : 'active';
      if (call.status !== status) {
        store.patch('calls', call.id, { status });
        publishCall(call.id);
      }
    }
    return c.json(out);
  });

  r.post('/voice/calls/:id/events', async (c) => {
    const call = getCall(c.req.param('id') ?? '');
    const ev = await parseBody(c, VoiceCallEventRequestSchema);
    const caseId = caseIdOf(call);
    switch (ev.type) {
      case 'answered': {
        if (isOver(call)) break;
        store.patch('calls', call.id, { status: 'active' });
        bus.emit({ type: 'call.answered', model: 'gpt-realtime', caseId, title: 'The call was answered', detail: { callId: call.id } });
        publishCall(call.id);
        break;
      }
      case 'transcript': {
        if (!ev.text || !ev.speaker) throw new HttpError(400, 'bad_request', 'transcript needs speaker and text');
        const line = { at: nowIso(), speaker: ev.speaker, text: ev.text };
        store.patch('calls', call.id, { transcript: [...call.transcript, line] });
        bus.emit({ type: 'call.transcript', model: 'gpt-realtime', caseId, title: `${ev.speaker}: ${ev.text}`, detail: { callId: call.id, ...line } });
        publishCall(call.id);
        break;
      }
      case 'ended': {
        if (isOver(call)) break;
        const neg = call.negotiationId ? store.getItem('negotiations', call.negotiationId) : undefined;
        const outcome = call.direction === 'inbound' ? 'qa' : neg?.outcome;
        store.patch('calls', call.id, {
          status: 'ended',
          endedAt: nowIso(),
          ...(outcome ? { outcome } : {}),
          ...(neg?.referenceNumber ? { referenceNumber: neg.referenceNumber } : {}),
        });
        bus.emit({ type: 'call.ended', model: 'gpt-realtime', caseId, title: 'The call ended', detail: { callId: call.id, outcome } });
        publishCall(call.id);
        if (call.direction === 'outbound') {
          // decide() already enqueued CALL_ENDED when it closed the negotiation; don't send a second one.
          if (neg?.outcome) {
            if (neg.state !== 'closed') ctx.enqueue({ id: newId('evt'), at: nowIso(), type: 'CALL_ENDED', callId: call.id, negotiationId: neg.id });
          } else ctx.enqueue({ id: newId('evt'), at: nowIso(), type: 'CALL_FAILED', callId: call.id, negotiationId: neg?.id, reason: 'ended_without_outcome' });
        }
        break;
      }
      case 'failed': {
        if (isOver(call)) break;
        store.patch('calls', call.id, { status: 'failed', endedAt: nowIso(), outcome: 'failed' });
        bus.emit({ type: 'call.failed', model: 'gpt-realtime', caseId, level: 'warn', title: 'The call failed', detail: { callId: call.id, sipStatus: ev.sipStatus } });
        publishCall(call.id);
        ctx.enqueue({
          id: newId('evt'),
          at: nowIso(),
          type: 'CALL_FAILED',
          callId: call.id,
          negotiationId: call.negotiationId,
          reason: 'sip_error',
          ...(ev.sipStatus ? { sipStatus: ev.sipStatus } : {}),
        });
        break;
      }
    }
    return c.body(null, 204);
  });

  r.post('/voice/inbound', async (c) => {
    const { room, callerPhone } = await parseBody(c, VoiceInboundRequestSchema);
    const known = samePhone(callerPhone, env('CUSTOMER_PHONE') ?? '');
    const id = newId('call');
    const call: Call = {
      id,
      direction: 'inbound',
      phone: callerPhone,
      room: room || roomForCall(id),
      status: 'active',
      transcript: [],
      startedAt: nowIso(),
    };
    store.put('calls', call);
    bus.emit({ type: 'call.answered', model: 'gpt-realtime', title: known ? 'Inbound call from Yoshua' : 'Inbound call from an unknown number', level: known ? 'info' : 'warn', detail: { callId: id, room: call.room } });
    publishCall(id);
    ctx.enqueue({ id: newId('evt'), at: nowIso(), type: 'INBOUND_CALL', callId: id, room: call.room, callerPhone });
    const body: VoiceInboundResponse = { callId: id, greeting: known ? INBOUND_GREETING : ACCOUNT_HOLDER_LINE, requirePin: true };
    return c.json(body);
  });

  r.post('/voice/calls/:id/verify-pin', async (c) => {
    const call = getCall(c.req.param('id') ?? '');
    const { digits } = await parseBody(c, VoiceVerifyPinRequestSchema);
    const fails = pinFailures.get(call.id) ?? 0;
    // Only an inbound call from Yoshua's own number can be verified (never the lender's line).
    if (call.direction !== 'inbound') return c.json({ ok: false, say: ACCOUNT_HOLDER_LINE });
    if (call.pinVerified) return c.json({ ok: true, say: PIN_OK_LINE });
    if (fails >= MAX_PIN_TRIES) return c.json({ ok: false, say: PIN_GOODBYE_LINE });
    const pin = env('INBOUND_PIN');
    const callerOk = samePhone(call.phone, env('CUSTOMER_PHONE') ?? '');
    if (callerOk && pin && digitsOf(digits) === digitsOf(pin)) {
      pinFailures.delete(call.id);
      store.patch('calls', call.id, { pinVerified: true });
      publishCall(call.id);
      return c.json({ ok: true, say: PIN_OK_LINE });
    }
    const n = fails + 1;
    pinFailures.set(call.id, n);
    bus.emit({ type: 'call.transcript', model: 'gpt-realtime', level: 'warn', title: `PIN failed (${n} of ${MAX_PIN_TRIES})`, detail: { callId: call.id, callerKnown: callerOk } });
    if (n >= MAX_PIN_TRIES) {
      const t = setTimeout(() => void ctx.dispatch.hangUp(call.room).catch(() => undefined), PIN_HANGUP_DELAY_MS);
      t.unref?.();
      return c.json({ ok: false, say: PIN_GOODBYE_LINE });
    }
    return c.json({ ok: false, say: callerOk ? PIN_RETRY_LINE : ACCOUNT_HOLDER_LINE });
  });

  r.post('/voice/calls/:id/ask', async (c) => {
    const call = getCall(c.req.param('id') ?? '');
    const { question } = await parseBody(c, VoiceAskRequestSchema);
    // Numbers only on an inbound call whose caller ID is CUSTOMER_PHONE and whose PIN matched.
    if (call.direction !== 'inbound' || !call.pinVerified || !samePhone(call.phone, env('CUSTOMER_PHONE') ?? '')) return c.json({ say: ACCOUNT_HOLDER_LINE });
    const say = await answerQuestion(ctx, question, { channel: 'voice', allowNumbers: true });
    return c.json({ say });
  });

  return r;
}

export { apiError };
