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
 *    - Messy and adversarial replies (code, never a model, decides; replies.ts has the signals):
 *      - Replies to a pending approval wait a moment (REPLY_BURST_MS of quiet, at most
 *        REPLY_BURST_MAX_MS) so a burst ("1", "wait", "2" / "yes", "wait") is read as one answer.
 *        Such a reply returns null at once and is acted on in the background (repliesSettled()).
 *      - A money-moving yes (call_limits, deal) must be clear (isClearYes): no "but", no "if", no
 *        "whatever", no yes-and-no, no other day or amount than the terms asked about. Anything
 *        else gets a "Just to check" with the exact terms.
 *      - A yes to a deal approval that replaced an earlier one (the lender changed terms) and that
 *        arrives within REAPPROVAL_GRACE_MS of it, or was sent before it, is asked about once.
 *      - "Go up to $50" / "only if under $15" before the call: an explicit new-limit question; only
 *        a YES to it changes the fee limit (and approves the call). During the call: the OK'd
 *        limit stands. "Ignore your rules", "approve everything", "pay it from savings": a plain
 *        refusal, then the open question again.
 *      - Nothing pending: a late yes/no/pick to an approval that timed out, was declined or was
 *        replaced gets an honest text ("...so I didn't accept it. Nothing changed.").
 * 3. ctx.enqueue(event), then return it (null when ignored: a duplicate, not from Yoshua, a
 *    "Just to check" question was texted instead, or the reply waits in a burst).
 * Callers never enqueue the result themselves.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  confirmTermsText,
  dealConditionText,
  feeLimitChangeText,
  feeLimitKeptText,
  formatMoney,
  hasNoWord,
  hasYesWord,
  isClearYes,
  isPaycheckNews,
  isPleasantry,
  limitsLockedText,
  mixedAnswerText,
  normalizeReply,
  OPTION_NAMES,
  parseReply,
  reaskText,
  refusalText,
  replySignals,
  termsFromPrompt,
  termsPhrase,
  type AgentEvent,
  type Approval,
  type ApprovalKind,
  type Cents,
  type MessageChannel,
  type OptionId,
  type ParsedReply,
  type ReplySignals,
} from '@pacepay/shared';
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

/** Quiet time after a reply to a pending approval before acting, so a burst of texts reads as one answer. */
const REPLY_BURST_MS = Number(process.env.PACEPAY_REPLY_BURST_MS ?? 1800);
/** A burst never holds an answer longer than this. */
const REPLY_BURST_MAX_MS = 4500;
/** A yes this soon after a re-sent deal approval (the lender changed terms) may have been meant for the old one. */
const REAPPROVAL_GRACE_MS = 20_000;
/** A late reply this long after the last approval closed still gets an honest "that one closed" text. */
const LATE_WINDOW_MS = 2 * 60 * 60_000;
/** A repeat yes this soon after the approval it answered needs no reply. */
const DUPLICATE_YES_MS = 3 * 60_000;
const CALL_STATES = new Set(['CALLING', 'NEGOTIATING', 'TEXT_NEGOTIATION', 'AWAITING_APPROVAL', 'CONFIRMING', 'HOLD_REQUESTED']);

/** The option PacePay last asked "did you mean...?" about, so a plain YES to that question picks it. */
const askedAbout = new WeakMap<Store, { approvalId: string; choice: number }>();
/** A new fee limit PacePay asked about ("raise your fee limit to $50, then call?"), waiting on his YES. */
const limitAsk = new WeakMap<Store, { approvalId: string; feeLimit: Cents }>();
/** Re-sent deal approvals whose new terms PacePay already spelled out once. */
const restated = new WeakMap<Store, Set<string>>();

interface Part {
  text: string;
  at: string;
  channel: MessageChannel;
  messageId: string;
}
interface Burst {
  parts: Part[];
  firstAt: number;
  timer?: NodeJS.Timeout;
}
const bursts = new WeakMap<Store, Burst>();
/** Bursts are acted on one after another, never two at once. */
const chains = new WeakMap<Store, Promise<void>>();

function alreadySeen(store: Store, id: string | undefined): boolean {
  if (!id) return false;
  let seen = seenByStore.get(store);
  if (!seen) seenByStore.set(store, (seen = new Set()));
  if (seen.has(id)) return true;
  seen.add(id);
  return false;
}

/** Resolves once every reply waiting in a burst has been acted on (tests, harnesses). */
export async function repliesSettled(store: Store): Promise<void> {
  for (;;) {
    const b = bursts.get(store);
    if (b) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    const chain = chains.get(store);
    if (!chain) return;
    await chain;
    if (chains.get(store) === chain && !bursts.get(store)) return;
  }
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
  const parsed = parseReply(text, { billUnconfirmed, optionIds: optionApproval?.optionIds });
  if (named) {
    const ok = named.kind === 'option_choice' ? parsed.kind === 'choice' : parsed.kind === 'yes' || parsed.kind === 'no';
    if (!ok) throw new ApprovalStateError(`"${text}" does not answer approval ${named.id}`);
  }

  const message = recordInbound(ctx, { text, channel: msg.channel, at });
  const part: Part = { text, at, channel: msg.channel, messageId: message.id };

  // Not about the pending approval at all: news that the paycheck is late (the orchestrator's paycheck
  // path), or a reply to "...if it hasn't landed. Reply NO to skip." when that was PacePay's last
  // question (an option's number or name still picks it).
  if (!named && (isPaycheckNews(text) || (lastAskWasPaycheckWatch(store) && parsed.kind !== 'choice' && parsed.kind !== 'correction'))) {
    return emit(ctx, { id: newId('evt'), at, type: 'TEXT', text, channel: msg.channel, messageId: message.id });
  }

  if (parsed.kind === 'correction' && bill && case_) {
    return emit(ctx, { id: newId('evt'), at, type: 'BILL_CORRECTION', caseId: case_.id, billId: bill.id, amount: parsed.amount, text });
  }

  // Any other reply while the bill is unconfirmed confirms it, unless it leaves an open bill check unanswered.
  const billCheckOpen = pendingYesNo?.kind === 'bill_confirm' && parsed.kind !== 'yes' && parsed.kind !== 'no';
  if (bill && billUnconfirmed && !billCheckOpen) store.patch('bills', bill.id, { confirmed: true });

  // A dashboard button answers exactly its approval, at once.
  if (named) {
    if (named.kind === 'option_choice') return parsed.kind === 'choice' ? answerChoice(ctx, named, parsed.choice, part) : null;
    return answerYesNo(ctx, named, parsed.kind === 'yes' ? 'yes' : 'no', part);
  }

  // A reply to a pending question waits a moment for the rest of a burst ("1", "wait", "2").
  if (waiting && REPLY_BURST_MS > 0) {
    collect(ctx, part);
    return null;
  }
  if (waiting) return routeReplies(ctx, [part]);
  return routeIdle(ctx, part, parsed);
}

/** Adds a reply to the burst; the burst is acted on after REPLY_BURST_MS of quiet. */
function collect(ctx: ToolContext, part: Part): void {
  const { store } = ctx;
  let b = bursts.get(store);
  if (!b) bursts.set(store, (b = { parts: [], firstAt: Date.now() }));
  b.parts.push(part);
  clearTimeout(b.timer);
  const burst = b;
  const wait = Math.max(0, Math.min(REPLY_BURST_MS, burst.firstAt + REPLY_BURST_MAX_MS - Date.now()));
  burst.timer = setTimeout(() => {
    bursts.delete(store);
    const run = (chains.get(store) ?? Promise.resolve()).then(() =>
      routeReplies(ctx, burst.parts).then(
        () => undefined,
        (err: Error) => {
          ctx.bus.emit({ type: 'message.in', model: 'code', level: 'error', title: `Could not act on a reply: ${err.message}`, detail: { texts: burst.parts.map((p) => p.text), stack: err.stack } });
        },
      ),
    );
    chains.set(store, run);
  }, wait);
}

/** The pending approvals, read when the reply is acted on (one may have closed during the burst). */
function openQuestions(ctx: ToolContext) {
  const optionApproval = pendingApproval(ctx, ['option_choice']);
  const pendingYesNo = pendingApproval(ctx, YES_NO_KINDS);
  return { optionApproval, waiting: newest(optionApproval, pendingYesNo) };
}

/** Acts on one reply, or on a burst of them read together. */
async function routeReplies(ctx: ToolContext, parts: Part[]): Promise<AgentEvent | null> {
  const { optionApproval, waiting } = openQuestions(ctx);
  const parse = (t: string) => parseReply(t, { optionIds: optionApproval?.optionIds });
  const last = parts[parts.length - 1]!;
  const joined: Part = { ...last, text: parts.map((p) => p.text).join(parts.length > 1 ? '. ' : '') };
  if (!waiting) return routeIdle(ctx, joined, parse(joined.text));
  if (parts.length > 1) {
    ctx.bus.emit({ type: 'message.in', model: 'code', caseId: waiting.caseId, title: `Read ${parts.length} texts in a row as one reply`, detail: { texts: parts.map((p) => p.text) } });
  }

  const meaningful = parts.filter((p) => !isPleasantry(p.text));
  if (meaningful.length <= 1) return decide(ctx, waiting, meaningful[0] ?? last, parse((meaningful[0] ?? last).text));

  // Several texts: the same answer twice ("yes", "go ahead") is that answer.
  const read = meaningful.map((p) => ({ p, r: parse(p.text) }));
  const key = (r: ParsedReply) => (r.kind === 'choice' ? `choice:${r.choice}` : r.kind);
  const keys = new Set(read.map((x) => key(x.r)));
  if (keys.size === 1 && !keys.has('text')) return decide(ctx, waiting, { ...read[0]!.p, at: last.at }, read[0]!.r);
  // A question in the burst is answered (and the open question asked again); nothing is acted on.
  if (meaningful.some((p) => replySignals(p.text).question)) return emitText(ctx, joined);
  // Ends in "wait" / "hold on": nothing yet.
  const lastRead = read[read.length - 1]!.r;
  if (lastRead.kind === 'wait') return hold(ctx, waiting, verdictFor(waiting, 'wait'), joined, 'burst ends in a wait');
  // "1", "wait", "2" / "2, actually 3": the last pick, after a change of mind, is the pick.
  if (waiting.kind === 'option_choice' && lastRead.kind === 'choice') {
    const changedMind = read.some((x, i) => (i < read.length - 1 && (x.r.kind === 'wait' || x.r.kind === 'no')) || /\b(?:actually|wait|nvm|nevermind|sorry|no|instead|change|scratch|make (?:it|that))\b/.test(normalizeReply(x.p.text)));
    if (changedMind) return decide(ctx, waiting, { ...read[read.length - 1]!.p }, lastRead);
    return hold(ctx, waiting, { act: 'ask', text: mixedAnswerText('option_choice', { count: waiting.optionIds?.length }) }, joined, 'different picks in one burst');
  }
  // Anything else: read the burst as one message, with every guard on.
  return decide(ctx, waiting, joined, parse(joined.text));
}

/** One reply (or a joined burst) to the pending question `waiting`. */
async function decide(ctx: ToolContext, waiting: Approval, part: Part, parsed: ParsedReply): Promise<AgentEvent | null> {
  const { store } = ctx;
  const { text } = part;
  const sig = replySignals(text);
  const moneyMoving = waiting.kind === 'deal' || waiting.kind === 'call_limits';
  const terms = moneyMoving ? termsFromPrompt(waiting.prompt) : null;
  const asked = askedAbout.get(store);
  askedAbout.delete(store);
  const note = (how: string, verdict: Verdict) => hold(ctx, waiting, verdict, part, how);
  const reask = () => reaskText(waiting.kind, waiting.optionIds?.length ?? waiting.choices.length, waiting.prompt);

  // The answer to "raise your fee limit to $50, then call?"
  const lim = limitAsk.get(store);
  if (lim) {
    limitAsk.delete(store);
    if (lim.approvalId === waiting.id && waiting.kind === 'call_limits') {
      if (parsed.kind === 'yes' || (isClearYes(text, null) && !sig.feeCap)) {
        applyFeeLimit(ctx, waiting, lim.feeLimit);
        return answerYesNo(ctx, waiting, 'yes', part);
      }
      if (parsed.kind === 'no' || (hasNoWord(text) && !hasYesWord(text))) return note('kept the fee limit', { act: 'ask', text: feeLimitKeptText(store.rules().feeLimit) });
      // anything else: read it fresh below (a new amount asks again)
    }
  }

  // Instructions aimed at PacePay itself: a plain refusal, then the open question again.
  if (sig.injection || sig.standing) return note('instructions to PacePay', { act: 'ask', text: `${refusalText(sig.injection ? 'injection' : 'standing')} ${reask()}` });
  if (sig.moveMoney && waiting.kind !== 'option_choice') return note('asked PacePay to move money', { act: 'ask', text: `${refusalText('moveMoney')} ${reask()}` });

  if (waiting.kind === 'option_choice') return decideChoice(ctx, waiting, part, parsed, asked);

  // Yes/no approvals.
  if (parsed.kind === 'yes') {
    if (moneyMoving && !isClearYes(text, terms)) return note('yes with strings attached', { act: 'ask', text: confirmTermsText(waiting.kind as 'deal' | 'call_limits', terms) });
    const stale = staleDealYes(ctx, waiting, part);
    if (stale) return note('yes may be for the earlier offer', { act: 'ask', text: stale });
    return answerYesNo(ctx, waiting, 'yes', part);
  }
  if (parsed.kind === 'no') return answerYesNo(ctx, waiting, 'no', part);
  if (parsed.kind === 'wait' || parsed.kind === 'defer') return note(`parser: ${parsed.kind}`, verdictFor(waiting, parsed.kind));

  if (moneyMoving && !sig.question) {
    // "Go up to $50" / "only if it's under $15" / "yes but no fee" before the call: a new limit needs its own YES.
    const n = normalizeReply(text);
    const cap = sig.feeCap ?? (sig.condition && /\b(?:no fees?|free|without a fee|zero fees?|for free)\b/.test(n) ? 0 : null);
    if (waiting.kind === 'call_limits' && cap !== null) {
      const current = store.rules().feeLimit;
      if (cap === current) return note('same fee limit', { act: 'ask', text: confirmTermsText('call_limits', terms) });
      limitAsk.set(store, { approvalId: waiting.id, feeLimit: cap });
      return note('asked for a new fee limit', { act: 'ask', text: feeLimitChangeText(current, cap) });
    }
    if (sig.condition || cap !== null) {
      return note('a condition', { act: 'ask', text: waiting.kind === 'deal' ? dealConditionText(terms) : limitsConditionText(terms) });
    }
    if (sig.mixed) return note('a yes and a no', { act: 'ask', text: mixedAnswerText(waiting.kind, { terms }) });
    if (sig.hedged) return note('hedged', { act: 'ask', text: confirmTermsText(waiting.kind as 'deal' | 'call_limits', terms) });
  }

  // A plain side question ("will this hurt my credit", "what's the fee?"): Q&A answers it, then the question is asked again.
  if (sig.question && !sig.condition && sig.feeCap === null && !hasYesWord(text) && !hasNoWord(text)) return act(ctx, waiting, { act: 'text' }, part, 'a side question');

  // Still ambiguous: let a model propose a reading, and let code decide.
  const lastText = store.thread().filter((m) => m.direction === 'out' && m.text).at(-1)?.text;
  const proposal = await proposeReply(ctx, text, waiting, lastText);
  // The approval may have been answered (dashboard button, timeout) while the model was thinking.
  if (store.mustGet('approvals', waiting.id).status !== 'pending') return routeIdle(ctx, part, parsed);
  const verdict = proposal ? validateProposal(waiting, proposal, text) : fallbackVerdict(waiting, text);
  if (verdict.act === 'answer' && verdict.answer === 'yes') {
    const stale = staleDealYes(ctx, waiting, part);
    if (stale) return note('yes may be for the earlier offer', { act: 'ask', text: stale });
  }
  return act(ctx, waiting, verdict, part, proposal ? `model: ${JSON.stringify(proposal)}` : 'no model reading');
}

/** A reply to the numbered list of options. */
async function decideChoice(ctx: ToolContext, waiting: Approval, part: Part, parsed: ParsedReply, asked: { approvalId: string; choice: number } | undefined): Promise<AgentEvent | null> {
  const { store } = ctx;
  if (parsed.kind === 'choice') {
    const event = answerChoice(ctx, waiting, parsed.choice, part);
    if (event) return event;
  }
  if (waiting.optionIds?.length) {
    // A plain YES to a list of options picks nothing by itself: offer PacePay's pick first, unless that was the question.
    if (parsed.kind === 'yes') {
      if (asked?.approvalId === waiting.id) {
        const event = answerChoice(ctx, waiting, asked.choice, part);
        if (event) return event;
      }
      return hold(ctx, waiting, verdictFor(waiting, 'defer'), part, 'parser: yes to the list');
    }
    if (parsed.kind === 'no') return hold(ctx, waiting, verdictFor(waiting, 'no'), part, 'parser: no to the list');
  }
  if (parsed.kind === 'wait' || parsed.kind === 'defer') return hold(ctx, waiting, verdictFor(waiting, parsed.kind), part, `parser: ${parsed.kind}`);
  // "no, go ahead" / "yeah no": a yes and a no, so ask which option rather than guess.
  if (replySignals(part.text).mixed) return hold(ctx, waiting, { act: 'ask', text: mixedAnswerText('option_choice', { count: waiting.optionIds?.length }) }, part, 'a yes and a no');
  const lastText = store.thread().filter((m) => m.direction === 'out' && m.text).at(-1)?.text;
  const proposal = await proposeReply(ctx, part.text, waiting, lastText);
  if (store.mustGet('approvals', waiting.id).status !== 'pending') return routeIdle(ctx, part, parsed);
  // "yeah lets do that one" right after "I'd go with option 1. OK?": that's the OK.
  if (proposal?.intent === 'yes' && proposal.confidence >= CHOICE_CONFIDENCE && asked?.approvalId === waiting.id && !replySignals(part.text).mixed && !replySignals(part.text).hedged) {
    const event = answerChoice(ctx, waiting, asked.choice, part);
    if (event) return event;
  }
  const verdict = proposal ? validateProposal(waiting, proposal, part.text) : fallbackVerdict(waiting, part.text);
  return act(ctx, waiting, verdict, part, proposal ? `model: ${JSON.stringify(proposal)}` : 'no model reading');
}

/**
 * Nothing is pending. A late answer to an approval that already closed gets an honest text instead
 * of Q&A; instructions to PacePay get a refusal; everything else is TEXT for Q&A.
 */
async function routeIdle(ctx: ToolContext, part: Part, parsed: ParsedReply): Promise<AgentEvent | null> {
  const { store } = ctx;
  const sig = replySignals(part.text);
  const c = store.currentCase();
  const say = async (text: string, how: string): Promise<null> => {
    ctx.bus.emit({ type: 'tool.result', model: 'code', caseId: c?.id, title: `Read "${part.text.slice(0, 40)}" as ${how}` });
    // "yes", "go ahead" in a row: the same honest line once, never twice in a row.
    if (store.thread().filter((m) => m.direction === 'out').at(-1)?.text === text) return null;
    await sendText(ctx, text, { caseId: c?.id });
    return null;
  };
  if (sig.injection || sig.standing) return say(refusalText(sig.injection ? 'injection' : 'standing'), 'instructions to PacePay');
  if (sig.moveMoney && !sig.question) return say(refusalText('moveMoney'), 'a request to move money');
  if (c && CALL_STATES.has(c.state) && (sig.feeCap !== null || /\b(?:fee limit|limit)\b/i.test(part.text)) && !sig.question) {
    return say(limitsLockedText(store.rules().feeLimit), 'a new limit during the call');
  }
  const late = lateReply(ctx, part, parsed, sig);
  if (late === 'silent') {
    ctx.bus.emit({ type: 'tool.result', model: 'code', caseId: c?.id, title: `"${part.text.slice(0, 40)}" repeats an answer already acted on; no reply needed` });
    return null;
  }
  if (late) return say(late, 'a late answer to a closed question');
  return emitText(ctx, part);
}

/** An honest text for an answer to a question that already closed; 'silent' for a repeat yes; null for Q&A. */
function lateReply(ctx: ToolContext, part: Part, parsed: ParsedReply, sig: ReplySignals): string | 'silent' | null {
  const { store } = ctx;
  const answerish = parsed.kind === 'yes' || parsed.kind === 'no' || parsed.kind === 'wait' || /^\d$/.test(normalizeReply(part.text)) || (part.text.split(/\s+/).length <= 6 && !sig.question && (hasYesWord(part.text) || hasNoWord(part.text)));
  if (!answerish) return null;
  const last = store
    .list('approvals')
    .filter((a) => a.status !== 'pending')
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
  if (!last) return null;
  const closedAt = Date.parse(last.resolvedAt ?? last.requestedAt);
  const age = Date.parse(ctx.clock.now()) - closedAt;
  if (!(age >= 0 && age < LATE_WINDOW_MS)) return null;
  const yes = parsed.kind === 'yes' || (hasYesWord(part.text) && !hasNoWord(part.text));
  const no = parsed.kind === 'no' || parsed.kind === 'wait' || (hasNoWord(part.text) && !hasYesWord(part.text));
  const neg = last.negotiationId ? store.getItem('negotiations', last.negotiationId) : undefined;
  const callOver = !neg || neg.state === 'closed';

  if (last.kind === 'deal') {
    const t = termsFromPrompt(last.prompt);
    const offer = t ? termsPhrase(t) : 'that offer';
    if (last.status === 'timeout' && (yes || no)) {
      if (neg?.outcome === 'deal') return null; // a later approval went through; Q&A has the facts
      if (yes) return callOver ? `Your reply came in after the call ended, so I didn't accept ${offer}. Nothing changed.` : `Your reply came in after that offer closed, so I didn't accept ${offer}. Nothing changed. If they make another offer, I'll text you first.`;
      return `OK. I didn't accept ${offer}, so nothing changed.`;
    }
    if (last.status === 'declined' && yes) return `You'd said NO to ${offer}, so I passed on it.${callOver ? ' Nothing changed.' : " If they make another offer, I'll text you first."}`;
    if (last.status === 'approved') {
      // The lender changed the terms after his yes and the call ended without a deal: say so, whatever he answers.
      if (callOver && neg && neg.outcome !== 'deal' && (yes || no)) return 'That call ended without a deal, so I didn\'t agree to anything and nothing changed.';
      if (no) {
        return `Your YES already went through, and I told them ${offer}. To change it now, you'd need to call the lender.`;
      }
      if (yes && age < DUPLICATE_YES_MS) return 'silent';
    }
    return null;
  }
  if (last.kind === 'call_limits') {
    if (last.status === 'declined' && yes) return "You'd said NO to the call, so I didn't call. Nothing changed.";
    if (last.status === 'approved' && no) {
      const c = last.caseId ? store.getItem('cases', last.caseId) : undefined;
      if (c && CALL_STATES.has(c.state)) return "I'm already on the call. I won't agree to anything without your YES.";
      return null;
    }
    if (last.status === 'approved' && yes && age < DUPLICATE_YES_MS) return 'silent';
    return null;
  }
  if (last.kind === 'option_choice' && last.status === 'answered') {
    const picked = Number(last.answer);
    const id = last.optionIds?.[picked - 1] as OptionId | undefined;
    const n = Number(normalizeReply(part.text));
    if (id && Number.isInteger(n) && n >= 1 && n <= (last.optionIds?.length ?? 0) && n !== picked) {
      return `You already picked ${picked}, ${OPTION_NAMES[id]}, so I went with that.`;
    }
    if (id && n === picked) return 'silent';
  }
  if (last.kind === 'bill_confirm' && last.status === 'approved' && yes && age < DUPLICATE_YES_MS) return 'silent';
  return null;
}

/**
 * A yes to a deal approval that replaced an earlier one (the lender changed the terms) is checked
 * once: it may have been typed for the old terms. Returns the "they changed the offer" text, or null.
 */
function staleDealYes(ctx: ToolContext, approval: Approval, part: Part): string | null {
  if (approval.kind !== 'deal') return null;
  const { store } = ctx;
  let seen = restated.get(store);
  if (!seen) restated.set(store, (seen = new Set()));
  if (seen.has(approval.id)) return null;
  const prev = store
    .list('approvals')
    .filter((a) => a.kind === 'deal' && a.id !== approval.id && a.requestedAt <= approval.requestedAt && (approval.negotiationId ? a.negotiationId === approval.negotiationId : a.caseId === approval.caseId))
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
  if (!prev) return null;
  const requested = Date.parse(approval.requestedAt);
  const sentBefore = Date.parse(part.at) < requested;
  const soon = Date.parse(ctx.clock.now()) - requested < REAPPROVAL_GRACE_MS;
  if (!sentBefore && !soon) return null;
  seen.add(approval.id);
  const now = termsFromPrompt(approval.prompt);
  const before = termsFromPrompt(prev.prompt);
  const same = now && before && termsPhrase(now) === termsPhrase(before);
  return confirmTermsText('deal', now, same ? null : before);
}

/** "ok but not friday" to the call's limits: the day is the first one that works, so say that and ask once more. */
function limitsConditionText(t: ReturnType<typeof termsFromPrompt>): string {
  if (!t) return confirmTermsText('call_limits', t);
  const fee = t.fee !== null ? `, with ${formatMoney(t.fee)} max in fees` : '';
  return `${t.label} is the first day that works for your balance, so that's the day I'd ask for${fee}. Should I make the call? Reply YES or NO.`;
}

/** A new fee limit he said YES to: his rules and this call's plan both change, and the dashboard hears about it. */
function applyFeeLimit(ctx: ToolContext, approval: Approval, feeLimit: Cents): void {
  const { store } = ctx;
  const from = store.rules().feeLimit;
  const rules = store.setRules({ ...store.rules(), feeLimit });
  ctx.bus.publish({ event: 'rules', data: rules });
  const c = approval.caseId ? store.getItem('cases', approval.caseId) : undefined;
  const neg = c?.negotiationId ? store.getItem('negotiations', c.negotiationId) : undefined;
  if (neg) {
    const next = store.patch('negotiations', neg.id, { callPlan: { ...neg.callPlan, feeLimit } });
    ctx.bus.publish({ event: 'negotiation', data: next });
  }
  ctx.bus.emit({ type: 'step.completed', model: 'code', caseId: approval.caseId, title: `Yoshua said YES to a new fee limit: ${from / 100} -> ${feeLimit / 100} dollars`, detail: { from, to: feeLimit } });
}

function answerYesNo(ctx: ToolContext, approval: Approval, answer: 'yes' | 'no', part: Part): AgentEvent | null {
  const { store } = ctx;
  if (store.mustGet('approvals', approval.id).status !== 'pending') return null;
  if (approval.kind === 'bill_confirm' && answer === 'yes') {
    const c = approval.caseId ? store.getItem('cases', approval.caseId) : store.currentCase();
    const bill = c?.billId ? store.getItem('bills', c.billId) : undefined;
    if (bill && !bill.confirmed) store.patch('bills', bill.id, { confirmed: true });
  }
  resolveApproval(ctx, approval.id, answer);
  return emit(ctx, { id: newId('evt'), at: part.at, type: 'APPROVAL_REPLY', approvalId: approval.id, caseId: approval.caseId, answer, text: part.text });
}

function answerChoice(ctx: ToolContext, approval: Approval, choice: number, part: Part): AgentEvent | null {
  const optionId = approval.optionIds?.[choice - 1];
  if (!optionId || ctx.store.mustGet('approvals', approval.id).status !== 'pending') return null;
  resolveApproval(ctx, approval.id, String(choice));
  return emit(ctx, { id: newId('evt'), at: part.at, type: 'CHOICE_REPLY', approvalId: approval.id, caseId: approval.caseId, choice, optionId, text: part.text });
}

/** "Take your time" / "Just to check": texts the question back and acts on nothing. */
async function hold(ctx: ToolContext, approval: Approval, verdict: Verdict, part: Part, how: string): Promise<AgentEvent | null> {
  return act(ctx, approval, verdict, part, how);
}

async function act(ctx: ToolContext, approval: Approval, verdict: Verdict, part: Part, how: string): Promise<AgentEvent | null> {
  const read = verdict.act === 'text' ? 'a side question' : verdict.act === 'ask' ? 'not a clear answer, asking' : 'an answer';
  ctx.bus.emit({ type: 'tool.result', model: 'code', caseId: approval.caseId, title: `Read "${part.text.slice(0, 40)}" as ${read}`, detail: { how, verdict } });
  if (verdict.act === 'choice') return answerChoice(ctx, approval, verdict.choice, part) ?? emitText(ctx, part);
  if (verdict.act === 'answer') return answerYesNo(ctx, approval, verdict.answer, part);
  if (verdict.act === 'ask') {
    if (approval.kind === 'option_choice' && verdict.choice) askedAbout.set(ctx.store, { approvalId: approval.id, choice: verdict.choice });
    await sendText(ctx, verdict.text, { caseId: approval.caseId });
    return null;
  }
  return emitText(ctx, part);
}

function verdictFor(approval: Approval, kind: 'wait' | 'defer' | 'no'): Verdict {
  const v = holdVerdict(approval, kind);
  // A deal's "Just to check" names the terms.
  if (v.act === 'ask' && kind === 'defer' && (approval.kind === 'deal' || approval.kind === 'call_limits')) return { act: 'ask', text: confirmTermsText(approval.kind, termsFromPrompt(approval.prompt)) };
  return v;
}

function emitText(ctx: ToolContext, part: Part): AgentEvent {
  return emit(ctx, { id: newId('evt'), at: part.at, type: 'TEXT', text: part.text, channel: part.channel, messageId: part.messageId });
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
