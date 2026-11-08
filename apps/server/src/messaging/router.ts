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
 *    case's bill exists and bill.confirmed is false; choiceCount = the pending option_choice
 *    approval's optionIds.length.
 *    - image -> BILL_PHOTO.
 *    - correction (only while the bill is unconfirmed) -> BILL_CORRECTION.
 *    - Any other reply while the bill is unconfirmed confirms it (store.patch bills confirmed: true);
 *      a yes/no to a pending bill_confirm does too.
 *    - yes / no with a pending call_limits, deal or bill_confirm approval -> resolveApproval() from
 *      ../approvals, then APPROVAL_REPLY.
 *    - choice with a pending option_choice approval -> resolveApproval(), then CHOICE_REPLY with
 *      optionId = approval.optionIds[choice - 1].
 *    - Everything else (including yes/no/numbers with nothing pending) -> TEXT.
 * 3. ctx.enqueue(event), then return it (null when ignored: a duplicate, or not from Yoshua).
 * Callers never enqueue the result themselves.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseReply, type AgentEvent, type Approval, type ApprovalKind, type MessageChannel } from '@pacepay/shared';
import type { ToolContext } from '../tools/registry';
import type { Store } from '../store';
import { ApprovalStateError, pendingApproval, resolveApproval } from '../approvals';
import { recordInbound } from './outbox';
import { newId } from '../ids';

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
  const parsed = parseReply(text, { billUnconfirmed, choiceCount: optionApproval?.optionIds?.length });
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

  if (parsed.kind === 'yes' || parsed.kind === 'no') {
    const approval = named ?? pendingApproval(ctx, YES_NO_KINDS);
    if (approval && YES_NO_KINDS.includes(approval.kind)) {
      resolveApproval(ctx, approval.id, parsed.kind);
      return emit(ctx, { ...base, type: 'APPROVAL_REPLY', approvalId: approval.id, caseId: approval.caseId, answer: parsed.kind, text });
    }
  }

  if (parsed.kind === 'choice' && optionApproval?.optionIds) {
    const optionId = optionApproval.optionIds[parsed.choice - 1];
    if (optionId) {
      resolveApproval(ctx, optionApproval.id, String(parsed.choice));
      return emit(ctx, { ...base, type: 'CHOICE_REPLY', approvalId: optionApproval.id, caseId: optionApproval.caseId, choice: parsed.choice, optionId, text });
    }
  }

  return emit(ctx, { ...base, type: 'TEXT', text, channel: msg.channel, messageId: message.id });
}

function emit(ctx: ToolContext, event: AgentEvent): AgentEvent {
  ctx.enqueue(event);
  return event;
}
