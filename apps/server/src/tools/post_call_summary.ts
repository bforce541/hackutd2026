/**
 * Tool `post_call_summary` (SPEC §5.6). Implemented by: model-tools.
 * Every post-call text is written by code from the negotiation's facts (Done text, the honest
 * changed-terms text, or noDealText); sends through ../messaging/outbox.ts; stores summary and
 * referenceNumber on the Call. No model writes it: free-form summaries claimed deals that never happened.
 */
import { TOOLS, doneText, formatDate, formatMoney, readDealReply, termsChangedText, termsFromPrompt, termsPhrase, type Call, type Negotiation } from '@pacepay/shared';
import { HUNG_UP_REASON, confirmedDeal } from '../agent/negotiator';
import { callEndText, readCallEnd, type CallEndRead } from '../messaging/call-end';
import { defineTool, type ToolContext } from './registry';
import { sendText } from '../messaging/outbox';
import { unsupportedNumbers } from './send_message';

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

/** The offer terms PacePay can stand behind naming: the one sent to Yoshua for approval, else one the lender confirmed on read-back. */
function namedOffer(ctx: ToolContext, neg: Negotiation | undefined): { newDay: number; fee: number } | undefined {
  if (!neg) return undefined;
  const asked = ctx.store
    .list('approvals')
    .filter((a) => a.kind === 'deal' && a.negotiationId === neg.id)
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
    .at(-1);
  if (asked?.newTerms) return asked.newTerms;
  const confirmed = [...neg.offers].reverse().find((o) => o.readBackConfirmed);
  if (confirmed) return { newDay: confirmed.newDay, fee: confirmed.fee };
  return undefined;
}

/** The lender's last offer heard on the call, when none was sent to Yoshua or read back. */
function lastOffer(neg: Negotiation | undefined): { newDay: number; fee: number } | undefined {
  const o = neg?.offers.at(-1);
  return o ? { newDay: o.newDay, fee: o.fee } : undefined;
}

/** The lender saying it is making the change now, without confirming it was done. */
const WILL_PROCESS =
  /\b(?:i'?ll|i will|i'?m going to|let me) (?:go ahead and |just )?(?:process|make|put through|submit|update|move|reschedule|change) (?:that|this|the|it|your)\b|\b(?:payment|due date) will (?:be )?(?:moved|changed|updated)\b/i;

/**
 * The honest text after a call that ended without a deal, from facts only:
 * "Northside held their offer of Fri, Nov 13 for $20 while you decided, but I didn't agree to anything. Nothing changed. Want me to try again?"
 */
export function noDealText(ctx: ToolContext, neg: Negotiation | undefined, call: Call, lender: string, itemLabel: string, end: CallEndRead = readCallEnd(call.transcript)): string {
  const outcome = neg?.outcome ?? call.outcome;
  const day0 = ctx.store.household().day0Date;
  const offer = namedOffer(ctx, neg);
  const terms = offer ? `${formatDate(offer.newDay, day0)} ${offer.fee === 0 ? 'with no fee' : `for ${formatMoney(offer.fee)}`}` : '';
  const claimed = offer ?? lastOffer(neg);
  const termsParen = claimed ? `${formatDate(claimed.newDay, day0)} (${claimed.fee === 0 ? 'no fee' : formatMoney(claimed.fee)})` : '';
  const deals = neg ? ctx.store.list('approvals').filter((a) => a.kind === 'deal' && a.negotiationId === neg.id) : [];
  const declined = deals.some((a) => a.status === 'declined');
  const again = 'Want me to try again?';
  // What the lender said to do next (a form, an app setting, a callback, a deadline) and any reference: never dropped.
  const steps = end.nextSteps.length ? ` They said ${end.nextSteps.join(', and ')}.` : '';
  const ref = end.reference ? ` They gave ref ${end.reference}.` : '';
  // An offer the lender made that passed PacePay's check (never a misheard one), for "they offered X, but...".
  const passed = new Set((neg?.checks ?? []).filter((c) => c.pass).map((c) => c.offerId));
  const checked = offer ?? [...(neg?.offers ?? [])].reverse().find((o) => passed.has(o.id));
  const heard = checked ? `${formatDate(checked.newDay, day0)} ${checked.fee === 0 ? 'with no fee' : `for ${formatMoney(checked.fee)}`}` : undefined;
  if (outcome === 'handoff_verification') {
    // "needs to talk to you directly" already says "call them": only a deadline from that note is added.
    const notes = end.nextSteps.map((x) => (x.startsWith('they want you to call them directly') ? x.replace('they want you to call them directly', '').trim() : x));
    const callBy = notes.find((x) => /^(?:before|by) /.test(x));
    const others = notes.filter((x) => x && !/^(?:before|by) /.test(x));
    const item = neg ? ctx.store.household().scheduled.find((x) => x.id === neg.itemId || x.id === neg.itemId.split(/[@#:]/)[0]) : undefined;
    const due = item && item.day >= ctx.clock.today() ? formatDate(item.day, day0) : undefined;
    return (
      `${lender} needs to talk to you directly before changing anything${callBy ? `, ${callBy}` : ''}, so nothing changed.` +
      `${others.length ? ` They said ${others.join(', and ')}.` : ''}${ref} Your ${itemLabel} is still due ${due ?? 'as before'}.`
    ).replace(/\s+/g, ' ');
  }
  if (declined) {
    // He turned it down with a counter ("$15", "not friday"): say what he wanted, not "you passed".
    const asked = deals.filter((a) => a.status === 'declined').at(-1)!;
    const t = termsFromPrompt(asked.prompt);
    const counter = ctx.store
      .thread()
      .filter((m) => m.direction === 'in' && m.text && m.at >= asked.requestedAt && (!asked.resolvedAt || m.at <= asked.resolvedAt))
      .map((m) => readDealReply(m.text!, t))
      .find((r) => r.kind === 'counter');
    const offerWords = t ? termsPhrase(t) : terms;
    if (counter?.fee !== undefined) return `You wanted a lower fee, but ${lender} didn't come down from ${offerWords || 'their offer'}, so I didn't agree to anything. Nothing changed.${ref}${steps}`;
    if (counter?.day) return `You didn't want ${t?.label ?? 'that day'}, and ${lender} didn't offer another day I could take, so I didn't agree to anything. Nothing changed.${ref}${steps}`;
    return `You passed on ${lender}'s offer${terms ? ` of ${terms}` : ''}, so I didn't agree to anything. Nothing changed.${ref}`;
  }
  // The lender says it already made a change nobody approved: say exactly that, never "nothing changed".
  // Not when the lender only offered something other than a move (a note, a next-cycle change): that is
  // never "they already moved it".
  const policyOnly = /^The lender wouldn't move the due date\./.test(neg?.closeReason ?? '');
  if (end.kind === 'lender_processed' && !policyOnly) return callEndText({ read: end, lender, itemLabel, terms, termsParen });
  // He approved, the lender said it would make the change, then the call ended before it confirmed it.
  // ("I'll go ahead and process that for you now", "your payment will be moved to that date").
  const lenderWill =
    end.lenderWill ||
    (call.transcript ?? []).some((l) => l.speaker === 'counterparty' && WILL_PROCESS.test(l.text));
  if (lenderWill && deals.some((a) => a.status === 'approved') && outcome !== 'deal' && !neg?.termsChange) {
    return `You approved ${terms || 'their offer'}, and ${lender} said it would make the change, but the call ended before they confirmed it, so I can't be sure it went through.${ref} Want me to call back to confirm?`;
  }
  if (outcome === 'approval_timeout') {
    // He did reply (a question, a maybe, a counter PacePay had to ask about): never "before you answered".
    const asked = deals.at(-1);
    const replied = !!asked && ctx.store.thread().some((m) => m.direction === 'in' && m.at >= asked.requestedAt);
    const why = replied ? "but I didn't get a clear YES from you before the call ended" : 'but the call ended before you answered';
    return (
      terms
        ? `${lender} offered ${terms}, ${why}, so I didn't agree to it. Nothing changed.${ref}${steps} ${again}`
        : `The call ended while I was waiting on your answer, so I didn't agree to anything. Nothing changed.${ref}${steps} ${again}`
    ).replace(/\s+/g, ' ');
  }
  const reason = neg?.closeReason?.trim();
  // A canned reason (hung up, voicemail, closed, dropped): the transcript says how it really ended.
  const generic = !reason || reason === HUNG_UP_REASON || /\b(?:voicemail|was closed|call dropped)\b/i.test(reason);
  if (generic && call.transcript?.length && (reason || outcome === 'no_deal' || !outcome)) return callEndText({ read: end, lender, itemLabel, terms, termsParen, heard });
  // A reason that already names the reference doesn't get it twice.
  const refOnce = /\bref\b/i.test(reason ?? '') ? '' : ref;
  if (reason && policyOnly) {
    // The other option was not taken, so what it would have done ("no late fee until the 13th") is not a next step.
    const item = neg ? ctx.store.household().scheduled.find((x) => x.id === neg.itemId || x.id === neg.itemId.split(/[@#:]/)[0]) : undefined;
    const due = item && item.day >= ctx.clock.today() ? ` Your ${itemLabel} is still due ${formatDate(item.day, day0)}.` : '';
    return `${reason}${due}${refOnce} ${again}`.replace(/\s+/g, ' ');
  }
  if (reason) return `${reason}${/nothing (?:changed|was agreed)/i.test(reason) ? '' : ' Nothing changed.'}${refOnce}${steps} ${again}`.replace(/\s+/g, ' ');
  if (terms) return `${lender} offered ${terms}, but it wasn't settled on the call, so I didn't agree to it. Nothing changed. ${again}`;
  if ((neg?.offers.length ?? 0) > 0) return `${lender} talked about moving your ${itemLabel}, but nothing was confirmed on the call, so I didn't agree to anything. Nothing changed. ${again}`;
  if (outcome === 'no_deal') return `${lender} wouldn't move your ${itemLabel}. Nothing changed.`;
  return `The call with ${lender} ended without a change to your ${itemLabel}. Nothing changed. ${again}`;
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
  const end = readCallEnd(call.transcript);
  // A reference the lender said in any state (a held offer, a change it says it made) is kept.
  const rawRef = call.referenceNumber ?? neg?.referenceNumber ?? end.reference;
  // Spelled out one character at a time ("LS-7-7-3-0-9-1"): written as one token.
  const referenceNumber = rawRef && /^[A-Z0-9]*(?:-[A-Z0-9]){3,}$/i.test(rawRef) ? rawRef.replace(/-/g, '').toUpperCase() : rawRef;

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
  } else {
    // No deal: the text is written by code from the facts (outcome, the offer read back or asked
    // about, the reason), never by a model. A model once wrote "The lender agreed..." after nothing
    // was agreed, and once sent a one-word text.
    text = noDealText(ctx, neg, call, lender, itemLabel, end);
  }
  const honest = !deal && tc && tc.status !== 'resolved' && tc.status !== 'yoshua_approved';
  if (referenceNumber && !honest && !text.includes(referenceNumber)) text = `${text} Ref ${referenceNumber}.`;

  const sent = await sendText(ctx, text, { caseId: scope.caseId, stepId: scope.stepId, model: 'nemotron-super' });
  if (!sent.sent) throw new Error(`post_call_summary: text was held (${sent.reason})`);
  ctx.store.patch('calls', call.id, { summary: text, ...(referenceNumber ? { referenceNumber } : {}) });
  return { messageId: sent.message.id, summary: text, ...(referenceNumber ? { referenceNumber } : {}) };
});
