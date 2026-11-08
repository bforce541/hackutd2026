/**
 * Tool `post_call_summary` (SPEC §5.6). Implemented by: model-tools.
 * Super writes 2-3 lines from the call's (or, for text mode, the negotiation's) transcript and
 * outcome; sends through ../messaging/outbox.ts; stores summary and referenceNumber on the Call.
 *
 * Facts check (SPEC §5.5): every $ amount and % in Super's text must appear in the facts built
 * from the negotiation. Otherwise it is regenerated once, then the template text is sent.
 */
import { TOOLS, doneText, formatDate, formatMoney, termsChangedText, type Call, type Negotiation, type TranscriptLine } from '@pacepay/shared';
import { confirmedDeal } from '../agent/negotiator';
import { defineTool, type ToolContext } from './registry';
import { sendText } from '../messaging/outbox';
import { unsupportedNumbers } from './send_message';
import { ModelUnavailableError } from '../models';

const SYSTEM = `You write the text message PacePay sends to Yoshua right after a call with a lender. 2 or 3 short plain sentences, no markdown, no emoji, no greeting.
Say what the lender agreed or refused, in plain words. Use only the facts given. Any dollar amount or percentage you write must be copied exactly from the facts; never compute or invent numbers. Do not mention a reference number (it is added for you).`;

export interface CallFacts {
  lines: string[];
  /** Strings a $ or % in the text may be copied from. */
  allowed: string[];
  template: string;
}

function outcomeLine(outcome: Call['outcome'] | undefined): string {
  switch (outcome) {
    case 'deal': return 'a deal was agreed and approved by Yoshua';
    case 'no_deal': return 'no deal was reached';
    case 'handoff_verification': return 'the lender needed to verify identity with Yoshua directly, so nothing was changed';
    case 'approval_timeout': return 'the lender was asked to hold the offer while Yoshua decided, and the call ended without an answer in time';
    case 'failed': return 'the call failed before any outcome';
    case 'qa': return 'an inbound question call';
    default: return 'the call ended';
  }
}

export function buildCallFacts(ctx: ToolContext, call: Call, neg: Negotiation | undefined, lender: string, itemLabel: string): CallFacts {
  const outcome = neg?.outcome ?? call.outcome;
  const day0 = ctx.store.household().day0Date;
  const lines = [`Lender: ${lender}`, `Outcome: ${outcomeLine(outcome)}`, ...(neg?.closeReason ? [`Why: ${neg.closeReason}`] : [])];
  const allowed: string[] = [];
  const offers = neg?.offers ?? [];
  const last = offers.at(-1);
  for (const o of offers) {
    const fee = o.fee === 0 ? 'no fee' : `a ${formatMoney(o.fee)} fee`;
    lines.push(`Offer heard: move the ${itemLabel} to ${formatDate(o.newDay, day0)} with ${fee}`);
    if (o.fee > 0) allowed.push(formatMoney(o.fee));
  }
  let template: string;
  if (outcome === 'deal' && last) {
    const fee = last.fee === 0 ? 'no fee' : `a ${formatMoney(last.fee)} fee`;
    template = `${lender} agreed to move your ${itemLabel} to ${formatDate(last.newDay, day0)} with ${fee}.`;
  } else if (neg?.closeReason && !neg.termsChange) template = `${neg.closeReason} Your ${itemLabel} is unchanged.`;
  else if (outcome === 'no_deal') template = `${lender} couldn't move your ${itemLabel}. Nothing changed.`;
  else if (outcome === 'handoff_verification') template = `${lender} needs to verify your identity before changing anything, so nothing changed. They'll contact you directly.`;
  else if (outcome === 'approval_timeout') template = `I asked ${lender} to hold their offer, but the call ended before you replied. Nothing changed.`;
  else template = `The call with ${lender} ended without a change to your ${itemLabel}.`;
  return { lines, allowed, template };
}

/** Every $ amount and % in `text` (also "20 dollars", "5 percent") appears in `allowed`: send_message's check. */
export function numbersAreGrounded(text: string, allowed: string[]): boolean {
  return unsupportedNumbers(text, Object.fromEntries(allowed.map((a, i) => [String(i), a]))).length === 0;
}

/** The offer the deal was struck on: the last read-back-confirmed offer that passed check_offer. */
function dealOffer(n: Negotiation): Negotiation['offers'][number] | undefined {
  const passed = new Set((n.checks ?? []).filter((c) => c.pass).map((c) => c.offerId));
  return [...n.offers].reverse().find((o) => o.readBackConfirmed && passed.has(o.id)) ?? n.offers.at(-1);
}

function transcriptText(lines: TranscriptLine[]): string {
  return lines.slice(-40).map((l) => `${l.speaker}: ${l.text}`).join('\n');
}

export const post_call_summaryTool = defineTool('post_call_summary', TOOLS.post_call_summary.input, TOOLS.post_call_summary.output, async (input, ctx, scope) => {
  const call = ctx.store.mustGet('calls', input.callId);
  const neg = call.negotiationId ? ctx.store.getItem('negotiations', call.negotiationId) : undefined;
  const cp = ctx.store.household().counterparties.find((c) => c.id === (call.counterpartyId ?? neg?.counterpartyId));
  // A payment already moved once is 'auto_payment@6': fall back to its base id for the label.
  const item = neg ? ctx.store.household().scheduled.find((s) => s.id === neg.itemId || s.id === neg.itemId.split(/[@#:]/)[0]) : undefined;
  const lender = cp?.name ?? 'The lender';
  const itemLabel = (item?.label ?? 'payment').toLowerCase();
  const facts = buildCallFacts(ctx, call, neg, lender, itemLabel);
  const lines = call.transcript.length ? call.transcript : (neg?.transcript ?? []);
  const referenceNumber = call.referenceNumber ?? neg?.referenceNumber;

  let text = facts.template;
  const outcome = neg?.outcome ?? call.outcome;
  // The Done text only for a deal Yoshua approved, the lender accepted, and nothing disputed at the end.
  const deal = neg && outcome === 'deal' && confirmedDeal(ctx, neg.id) ? dealOffer(neg) : undefined;
  const tc = neg?.termsChange;
  if (!deal && tc && tc.status !== 'resolved' && tc.status !== 'yoshua_approved') {
    // The lender changed the terms and PacePay didn't agree: the honest text, written by code.
    text = termsChangedText({
      kind: tc.kind,
      approved: tc.previousTerms,
      ...(tc.newTerms ? { proposed: tc.newTerms } : {}),
      approvedByYou: tc.afterApproval,
      youDeclined: tc.status === 'yoshua_declined',
      day0Date: ctx.store.household().day0Date,
    });
  } else if (deal) {
    // SPEC §5.5: the Done text is filled by code, not written by a model.
    text = doneText({ itemLabel: item?.label ?? 'payment', toDay: deal.newDay, fee: deal.fee, reference: referenceNumber, day0Date: ctx.store.household().day0Date });
  } else if (ctx.models.available('orchestrator')) {
    const user = `FACTS\n${facts.lines.join('\n')}\n\nTRANSCRIPT\n${transcriptText(lines) || '(none)'}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await ctx.models.chat({
          role: 'orchestrator',
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
          caseId: scope.caseId,
          stepId: scope.stepId,
          title: 'Super wrote the call summary',
        });
        const candidate = res.text.trim().replace(/\s*\n+\s*/g, ' ');
        if (candidate && numbersAreGrounded(candidate, facts.allowed)) {
          text = candidate;
          break;
        }
        ctx.bus.emit({ type: 'tool.result', tool: 'post_call_summary', model: 'nemotron-super', caseId: scope.caseId, stepId: scope.stepId, level: 'warn', title: attempt === 0 ? 'Summary had a number outside the facts; regenerating' : 'Summary still had a number outside the facts; using the template', detail: { candidate } });
      } catch (err) {
        if (!(err instanceof ModelUnavailableError)) ctx.bus.emit({ type: 'tool.result', tool: 'post_call_summary', model: 'nemotron-super', caseId: scope.caseId, level: 'warn', title: `Summary model failed (${(err as Error).message}); using the template` });
        break;
      }
    }
  }
  const honest = !deal && tc && tc.status !== 'resolved' && tc.status !== 'yoshua_approved';
  if (referenceNumber && !honest && !text.includes(referenceNumber)) text = `${text} Ref ${referenceNumber}.`;

  const sent = await sendText(ctx, text, { caseId: scope.caseId, stepId: scope.stepId, model: 'nemotron-super' });
  if (!sent.sent) throw new Error(`post_call_summary: text was held (${sent.reason})`);
  ctx.store.patch('calls', call.id, { summary: text, ...(referenceNumber ? { referenceNumber } : {}) });
  return { messageId: sent.message.id, summary: text, ...(referenceNumber ? { referenceNumber } : {}) };
});
