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
import type { AgentEvent, MessageChannel } from '@pacepay/shared';
import type { ToolContext } from '../tools/registry';

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

export async function routeIncoming(_ctx: ToolContext, _msg: IncomingFromYoshua): Promise<AgentEvent | null> {
  throw new Error('messaging.routeIncoming: not implemented yet');
}
