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
 *    approval's optionIds (so "1", "yea option 1", "the first one" and "call them" all mean option 1).
 *    - image -> BILL_PHOTO.
 *    - correction (only while the bill is unconfirmed) -> BILL_CORRECTION.
 *    - Any other reply while the bill is unconfirmed confirms it (store.patch bills confirmed: true),
 *      except one that leaves a pending bill_confirm open; a yes/no to a pending bill_confirm does too.
 *    - yes / no with a pending call_limits, deal or bill_confirm approval -> resolveApproval() from
 *      ../approvals, then APPROVAL_REPLY.
 *    - choice with a pending option_choice approval -> resolveApproval(), then CHOICE_REPLY with
 *      optionId = approval.optionIds[choice - 1].
 *    - News that the paycheck is late, or a reply when PacePay's last text was the paycheck watch
 *      ("...Reply NO to skip."), is never read as an answer to an approval: TEXT, for the orchestrator.
 *    - yes / no answer the newest pending question (what PacePay asked last).
 *    - While an approval waits, nothing that might answer it falls through to Q&A:
 *      - a plain yes / "you pick" / "idk" to the options offers PacePay's pick ("I'd go with option 1,
 *        calling your lender. OK?"), and a YES (or a model-read yes) to that picks it; a no /
 *        "neither" holds off.
 *      - "wait" / "hold on" / "not yet" -> a short "take your time" with the question restated.
 *      - anything else goes to messaging/classify.ts: a decide-role model proposes a reading, code
 *        validates it against that approval's own choices. A confident, valid reading acts as above;
 *        an unsure, conditional ("ok but no fee") or unclear one texts a "Just to check" that names
 *        the choices and acts on nothing (returns null). Only a real side question ("what's the
 *        fee?") becomes TEXT, and the orchestrator re-asks after answering it.
 *      - money-moving approvals (call_limits, deal) never act on anything but a clear yes.
 *    - Everything else (including yes/no/numbers with nothing pending) -> TEXT.
 * 3. ctx.enqueue(event), then return it (null when ignored: a duplicate, not from Yoshua, or a
 *    "Just to check" question was texted instead).
 * Callers never enqueue the result themselves.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isPaycheckNews, parseReply, type AgentEvent, type Approval, type ApprovalKind, type MessageChannel } from '@pacepay/shared';
import type { ToolContext } from '../tools/registry';
import type { Store } from '../store';
import { ApprovalStateError, pendingApproval, resolveApproval } from '../approvals';
import { recordInbound, sendText } from './outbox';
import { newId } from '../ids';
import { holdVerdict, proposeReply, validateProposal, CHOICE_CONFIDENCE, type Verdict } from './classify';

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
  const pendingYesNo = named && YES_NO_KINDS.includes(named.kind) ? named : named ? null : pendingApproval(ctx, YES_NO_KINDS);
  // What PacePay asked last: a reply is read against that question.
  const waiting = named ?? newest(optionApproval, pendingYesNo);
  // A yes/no answers the newest question: a plain "ok" after the options list is not a yes to an older one.
  const yesNoApproval = waiting && YES_NO_KINDS.includes(waiting.kind) ? waiting : null;
  const parsed = parseReply(text, { billUnconfirmed, optionIds: optionApproval?.optionIds });
  if (named) {
    const ok = named.kind === 'option_choice' ? parsed.kind === 'choice' : parsed.kind === 'yes' || parsed.kind === 'no';
    if (!ok) throw new ApprovalStateError(`"${text}" does not answer approval ${named.id}`);
  }

  const message = recordInbound(ctx, { text, channel: msg.channel, at });
  const base = { id: newId('evt'), at };

  // Not about the pending approval at all: news that the paycheck is late (the orchestrator's paycheck
  // path), or a reply to "...if it hasn't landed. Reply NO to skip." when that was PacePay's last
  // question (an option's number or name still picks it).
  if (!named && (isPaycheckNews(text) || (lastAskWasPaycheckWatch(store) && parsed.kind !== 'choice' && parsed.kind !== 'correction'))) {
    return emit(ctx, { ...base, type: 'TEXT', text, channel: msg.channel, messageId: message.id });
  }

  if (parsed.kind === 'correction' && bill && case_) {
    return emit(ctx, { ...base, type: 'BILL_CORRECTION', caseId: case_.id, billId: bill.id, amount: parsed.amount, text });
  }

  // Any other reply while the bill is unconfirmed confirms it, unless it leaves an open bill check unanswered.
  const billCheckOpen = pendingYesNo?.kind === 'bill_confirm' && parsed.kind !== 'yes' && parsed.kind !== 'no';
  if (bill && billUnconfirmed && !billCheckOpen) store.patch('bills', bill.id, { confirmed: true });

  const asked = askedAbout.get(store);
  askedAbout.delete(store);

  const answerYesNo = (approval: Approval, answer: 'yes' | 'no') => {
    if (approval.kind === 'bill_confirm' && answer === 'yes' && bill && !store.getItem('bills', bill.id)?.confirmed) store.patch('bills', bill.id, { confirmed: true });
    resolveApproval(ctx, approval.id, answer);
    return emit(ctx, { ...base, type: 'APPROVAL_REPLY', approvalId: approval.id, caseId: approval.caseId, answer, text });
  };
  const answerChoice = (approval: Approval, choice: number) => {
    const optionId = approval.optionIds?.[choice - 1];
    if (!optionId) return null;
    resolveApproval(ctx, approval.id, String(choice));
    return emit(ctx, { ...base, type: 'CHOICE_REPLY', approvalId: approval.id, caseId: approval.caseId, choice, optionId, text });
  };
  /** Texts a "Just to check" (or "take your time") message and acts on nothing. */
  const askToCheck = async (approval: Approval, question: string, choice?: number): Promise<null> => {
    if (approval.kind === 'option_choice' && choice) askedAbout.set(store, { approvalId: approval.id, choice });
    await sendText(ctx, question, { caseId: approval.caseId });
    return null;
  };
  const act = async (approval: Approval, verdict: Verdict, how: string): Promise<AgentEvent | null | undefined> => {
    const read = verdict.act === 'text' ? 'a side question' : verdict.act === 'ask' ? 'not a clear answer, asking' : 'an answer';
    ctx.bus.emit({ type: 'tool.result', model: 'code', caseId: approval.caseId, title: `Read "${text.slice(0, 40)}" as ${read}`, detail: { how, verdict } });
    if (verdict.act === 'choice') return answerChoice(approval, verdict.choice) ?? undefined;
    if (verdict.act === 'answer') return answerYesNo(approval, verdict.answer);
    if (verdict.act === 'ask') return askToCheck(approval, verdict.text, verdict.choice);
    return undefined; // TEXT
  };

  if ((parsed.kind === 'yes' || parsed.kind === 'no') && yesNoApproval) return answerYesNo(yesNoApproval, parsed.kind);

  if (parsed.kind === 'choice' && optionApproval?.optionIds) {
    const event = answerChoice(optionApproval, parsed.choice);
    if (event) return event;
  }

  if (waiting && !named) {
    if (waiting.kind === 'option_choice' && waiting.optionIds?.length) {
      // A plain YES to a list of options picks nothing by itself: offer PacePay's pick first, unless that was the question.
      if (parsed.kind === 'yes') {
        if (asked?.approvalId === waiting.id) {
          const event = answerChoice(waiting, asked.choice);
          if (event) return event;
        }
        return (await act(waiting, holdVerdict(waiting, 'defer'), 'parser: yes to the list')) ?? null;
      }
      if (parsed.kind === 'no') return (await act(waiting, holdVerdict(waiting, 'no'), 'parser: no to the list')) ?? null;
    }
    if (parsed.kind === 'wait' || parsed.kind === 'defer') {
      const done = await act(waiting, holdVerdict(waiting, parsed.kind), `parser: ${parsed.kind}`);
      if (done !== undefined) return done;
    }
    // Still ambiguous: let a model propose a reading, and let code decide.
    if (parsed.kind === 'text' || parsed.kind === 'choice') {
      const lastText = store.thread().filter((m) => m.direction === 'out' && m.text).at(-1)?.text;
      const proposal = await proposeReply(ctx, text, waiting, lastText);
      // The approval may have been answered (dashboard button, timeout) while the model was thinking.
      if (store.mustGet('approvals', waiting.id).status === 'pending') {
        // "yeah lets do that one" right after "I'd go with option 1. OK?": that's the OK.
        if (proposal?.intent === 'yes' && proposal.confidence >= CHOICE_CONFIDENCE && asked?.approvalId === waiting.id) {
          const event = answerChoice(waiting, asked.choice);
          if (event) return event;
        }
        const verdict = proposal ? validateProposal(waiting, proposal, text) : fallbackVerdict(waiting, text);
        const done = await act(waiting, verdict, proposal ? `model: ${JSON.stringify(proposal)}` : 'no model reading');
        if (done !== undefined) return done;
      }
    }
  }

  return emit(ctx, { ...base, type: 'TEXT', text, channel: msg.channel, messageId: message.id });
}

/** PacePay's last text was the paycheck watch offer ("...Reply NO to skip."), so his reply is about that. */
function lastAskWasPaycheckWatch(store: Store): boolean {
  const last = store.thread().filter((m) => m.direction === 'out').at(-1);
  return !!last?.text && /Reply NO to skip\.?\s*$/.test(last.text);
}

/** The approval asked about last. */
function newest(...as: (Approval | null)[]): Approval | null {
  return as.filter((a): a is Approval => !!a).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0] ?? null;
}

/** No model reading (none configured, too slow, failed): a short reply gets a "Just to check", a real question goes to Q&A. */
function fallbackVerdict(approval: Approval, text: string): Verdict {
  const short = text.split(/\s+/).length <= 6 && !text.includes('?');
  if (!short) return { act: 'text' };
  return validateProposal(approval, { intent: 'unclear', choice: null, confidence: 0 }, text);
}

function emit(ctx: ToolContext, event: AgentEvent): AgentEvent {
  ctx.enqueue(event);
  return event;
}
