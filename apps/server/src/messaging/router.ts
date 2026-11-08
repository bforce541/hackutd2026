/**
 * Turns one message from Yoshua into an AgentEvent (SPEC §5.1). Implemented by: photon.
 *
 * Used for iMessage (index.ts passes each InboundMessage from the port, with the photo already
 * fetched), POST /api/thread (coach chat), POST /api/demo/customer-says, POST /api/demo/bill-photo
 * and POST /api/approvals/:id (a dashboard button; `approvalId` names the approval to answer).
 *
 * Steps, in order:
 * 1. De-duplicate on externalId. Store an image with store.putMedia (source 'inbound' or 'upload'),
 *    then record the message with recordInbound() from ./outbox (thread + message.in + SSE).
 * 2. Classify with parseReply() from @pacepay/shared. ReplyContext: billUnconfirmed = the current
 *    case's bill exists and bill.confirmed is false; optionIds = the pending option_choice
 *    approval's optionIds (so "1", "the first one" and "call them" all mean option 1).
 *    - image -> BILL_PHOTO.
 *    - correction (only while the bill is unconfirmed) -> BILL_CORRECTION.
 *    - Any other reply while the bill is unconfirmed confirms it (store.patch bills confirmed: true);
 *      a yes/no to a pending bill_confirm does too.
 *    - yes / no with a pending call_limits, deal or bill_confirm approval -> resolveApproval() from
 *      ../approvals, then APPROVAL_REPLY.
 *    - choice with a pending option_choice approval -> resolveApproval(), then CHOICE_REPLY with
 *      optionId = approval.optionIds[choice - 1].
 *    - A reply parseReply() calls TEXT while an option_choice, call_limits or deal approval waits
 *      (and no bill is unconfirmed) goes to messaging/classify.ts: a decide-role model proposes a
 *      reading, code validates it against that approval's own choices. A confident, valid reading
 *      acts as above; an unsure one texts "Just to check, did you mean option 1, ...?" and acts on
 *      nothing (returns null); anything else, or no model, stays TEXT.
 *    - A plain yes while only an option_choice waits does not pick anything: it asks the same
 *      "Just to check" (option 1, or the option last asked about), and a YES to that picks it.
 *    - Everything else (including yes/no/numbers with nothing pending) -> TEXT.
 * 3. ctx.enqueue(event), then return it (null when ignored: a duplicate, not from Yoshua, or a
 *    "Just to check" question was texted instead).
 * Callers never enqueue the result themselves.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clarifyChoiceText, parseReply, type AgentEvent, type Approval, type ApprovalKind, type MessageChannel } from '@pacepay/shared';
import type { ToolContext } from '../tools/registry';
import type { Store } from '../store';
import { ApprovalStateError, pendingApproval, resolveApproval } from '../approvals';
import { recordInbound, sendText } from './outbox';
import { newId } from '../ids';
import { proposeReply, validateProposal } from './classify';

export interface IncomingFromYoshua {
  text?: string;
  /** Image bytes already fetched (iMessage photo or multipart upload). */
  image?: { data: Buffer; contentType: string; name: string };
  /** Set by POST /api/demo/bill-photo with the brake_quote fixture (BillPhotoEvent.fixture). */
  fixture?: 'brake_quote';
  channel: MessageChannel;
  /** Provider message id, for de-duplication. */
  externalId?: string;
  /** POST /api/approvals/:id: answer exactly this approval (409 if it is not pending). */
  approvalId?: string;
  at?: string;
}

const YES_NO_KINDS: readonly ApprovalKind[] = ['call_limits', 'deal', 'bill_confirm'];
const seenByStore = new WeakMap<Store, Set<string>>();
const FIXTURE_PATH = fileURLToPath(new URL('../../fixtures/brake_quote.png', import.meta.url));

/** The option PacePay last asked "did you mean...?" about, so a plain YES to that question picks it. */
const askedAbout = new WeakMap<Store, { approvalId: string; choice: number }>();

function alreadySeen(store: Store, id: string | undefined): boolean {
  if (!id) return false;
  let seen = seenByStore.get(store);
  if (!seen) seenByStore.set(store, (seen = new Set()));
  if (seen.has(id)) return true;
  seen.add(id);
  return false;
}

export async function routeIncoming(ctx: ToolContext, msg: IncomingFromYoshua): Promise<AgentEvent | null> {
  const { store } = ctx;
  if (alreadySeen(store, msg.externalId)) return null;
  const at = msg.at ?? ctx.clock.now();

  // Photo (iMessage or upload) or the brake_quote fixture: store the bytes, record, start a bill case.
  const photo = msg.image
    ? { data: msg.image.data, contentType: msg.image.contentType, name: msg.image.name, source: (msg.channel === 'imessage' ? 'inbound' : 'upload') as 'inbound' | 'upload' }
    : msg.fixture
      ? { data: readFileSync(FIXTURE_PATH), contentType: 'image/png', name: 'brake_quote.png', source: 'fixture' as const }
      : null;
  if (photo) {
    const meta = store.putMedia({ id: newId('media'), contentType: photo.contentType, name: photo.name, source: photo.source }, photo.data);
    const message = recordInbound(ctx, { mediaId: meta.id, channel: msg.channel, at });
    return emit(ctx, {
      type: 'BILL_PHOTO',
      id: newId('evt'),
      at,
      mediaId: meta.id,
      messageId: message.id,
      ...(msg.fixture ? { fixture: msg.fixture } : {}),
    });
  }

  const text = msg.text?.trim();
  if (!text) return null;

  const case_ = store.currentCase();
  const bill = case_?.billId ? store.getItem('bills', case_.billId) : undefined;
  const billUnconfirmed = !!bill && !bill.confirmed;

  // A dashboard button names its approval: validate it before anything is recorded (409 when not pending).
  let named: Approval | null = null;
  if (msg.approvalId) {
    named = store.mustGet('approvals', msg.approvalId);
    if (named.status !== 'pending') throw new ApprovalStateError(`Approval ${named.id} is ${named.status}, not pending`);
  }
  const optionApproval = named?.kind === 'option_choice' ? named : named ? null : pendingApproval(ctx, ['option_choice']);
  const parsed = parseReply(text, { billUnconfirmed, optionIds: optionApproval?.optionIds });
  if (named) {
    const ok = named.kind === 'option_choice' ? parsed.kind === 'choice' : parsed.kind === 'yes' || parsed.kind === 'no';
    if (!ok) throw new ApprovalStateError(`"${text}" does not answer approval ${named.id}`);
  }

  const message = recordInbound(ctx, { text, channel: msg.channel, at });
  const base = { id: newId('evt'), at };

  if (parsed.kind === 'correction' && bill && case_) {
    return emit(ctx, { ...base, type: 'BILL_CORRECTION', caseId: case_.id, billId: bill.id, amount: parsed.amount, text });
  }

  // Any other reply while the bill is unconfirmed confirms it.
  if (bill && billUnconfirmed) store.patch('bills', bill.id, { confirmed: true });

  const asked = askedAbout.get(store);
  askedAbout.delete(store);

  const answerYesNo = (approval: Approval, answer: 'yes' | 'no') => {
    resolveApproval(ctx, approval.id, answer);
    return emit(ctx, { ...base, type: 'APPROVAL_REPLY', approvalId: approval.id, caseId: approval.caseId, answer, text });
  };
  const answerChoice = (approval: Approval, choice: number) => {
    const optionId = approval.optionIds?.[choice - 1];
    if (!optionId) return null;
    resolveApproval(ctx, approval.id, String(choice));
    return emit(ctx, { ...base, type: 'CHOICE_REPLY', approvalId: approval.id, caseId: approval.caseId, choice, optionId, text });
  };
  /** Texts a "Just to check" question and acts on nothing. */
  const askToCheck = async (approval: Approval, question: string, choice?: number): Promise<null> => {
    if (approval.kind === 'option_choice' && choice) askedAbout.set(store, { approvalId: approval.id, choice });
    await sendText(ctx, question, { caseId: approval.caseId });
    return null;
  };

  if (parsed.kind === 'yes' || parsed.kind === 'no') {
    const approval = named ?? pendingApproval(ctx, YES_NO_KINDS);
    if (approval && YES_NO_KINDS.includes(approval.kind)) return answerYesNo(approval, parsed.kind);
  }

  if (parsed.kind === 'choice' && optionApproval?.optionIds) {
    const event = answerChoice(optionApproval, parsed.choice);
    if (event) return event;
  }

  // A plain YES to a list of options picks nothing by itself: confirm what was meant first.
  if (parsed.kind === 'yes' && optionApproval?.optionIds?.length && !named) {
    if (asked?.approvalId === optionApproval.id) {
      const event = answerChoice(optionApproval, asked.choice);
      if (event) return event;
    }
    return askToCheck(optionApproval, clarifyChoiceText(1, optionApproval.optionIds[0]!), 1);
  }

  // Still ambiguous with an approval waiting: let a model propose a reading, and let code decide.
  if (parsed.kind === 'text' && !named && !billUnconfirmed) {
    const waiting = pendingApproval(ctx, ['option_choice', 'call_limits', 'deal']);
    const proposal = waiting ? await proposeReply(ctx, text, waiting) : null;
    // The approval may have been answered (dashboard button, timeout) while the model was thinking.
    if (waiting && proposal && store.mustGet('approvals', waiting.id).status === 'pending') {
      const verdict = validateProposal(waiting, proposal);
      const read = verdict.act === 'text' ? 'not an answer' : verdict.act === 'ask' ? 'unsure, asking to check' : 'an answer';
      ctx.bus.emit({ type: 'tool.result', model: 'code', caseId: waiting.caseId, title: `Read "${text.slice(0, 40)}" as ${read}`, detail: { proposal, verdict: verdict.act } });
      if (verdict.act === 'choice') {
        const event = answerChoice(waiting, verdict.choice);
        if (event) return event;
      } else if (verdict.act === 'answer') {
        return answerYesNo(waiting, verdict.answer);
      } else if (verdict.act === 'ask') {
        return askToCheck(waiting, verdict.text, verdict.choice);
      }
    }
  }

  return emit(ctx, { ...base, type: 'TEXT', text, channel: msg.channel, messageId: message.id });
}

function emit(ctx: ToolContext, event: AgentEvent): AgentEvent {
  ctx.enqueue(event);
  return event;
}
