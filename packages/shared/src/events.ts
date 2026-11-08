/**
 * Event contracts: the agent's input events (SPEC §5.1) and the server-sent events (SPEC §4).
 * Owned by Ram.
 */
import type {
  ActivityEvent,
  Approval,
  Bill,
  ArenaProgress,
  Call,
  Case,
  Cents,
  Day,
  Forecast,
  HealthScore,
  ISOTimestamp,
  Lowest,
  Message,
  MessageChannel,
  Negotiation,
  OptionId,
  Plan,
  Rules,
} from './types';

// ---------------------------------------------------------------------------
// Agent events (SPEC §5.1). agent.handle(event) takes exactly this union.
// ---------------------------------------------------------------------------

interface AgentEventBase {
  id: string;
  at: ISOTimestamp;
}

/** An image from Yoshua, or POST /api/demo/bill-photo. Starts a new case and a plan. */
export interface BillPhotoEvent extends AgentEventBase {
  type: 'BILL_PHOTO';
  mediaId: string; // served from /api/media/:id
  messageId?: string; // the inbound thread message carrying the photo
  fixture?: 'brake_quote'; // set when injected from the demo endpoint
}

/** A number from Yoshua while an option_choice approval is pending. "n" maps to optionIds[n-1]. */
export interface ChoiceReplyEvent extends AgentEventBase {
  type: 'CHOICE_REPLY';
  approvalId: string;
  caseId?: string;
  choice: number; // 1-based, as typed
  optionId: OptionId; // already mapped through the approval's optionIds
  text: string; // the raw reply
}

/** "yes" or "no" from Yoshua while a call_limits, deal or bill_confirm approval is pending. */
export interface ApprovalReplyEvent extends AgentEventBase {
  type: 'APPROVAL_REPLY';
  approvalId: string;
  caseId?: string;
  answer: 'yes' | 'no';
  text: string;
}

/** A reply with a dollar amount while the case's bill is unconfirmed, e.g. "it's $700". */
export interface BillCorrectionEvent extends AgentEventBase {
  type: 'BILL_CORRECTION';
  caseId: string;
  billId: string;
  amount: Cents;
  /** Addition: the corrected due day ("its not due till friday"), when the correction names one. */
  dueDay?: Day;
  text: string;
}

/** Any other text from Yoshua (iMessage or coach chat). Runs answer_question. */
export interface TextEvent extends AgentEventBase {
  type: 'TEXT';
  text: string;
  channel: MessageChannel;
  messageId?: string;
}

/** The watcher on each clock change, and once per real day. */
export interface DailyCheckEvent extends AgentEventBase {
  type: 'DAILY_CHECK';
  day: Day;
  reason: 'clock' | 'real_day';
}

/** Daily check: a CD matures within 2 business days. A new case and a short plan (no call). */
export interface CdMaturingEvent extends AgentEventBase {
  type: 'CD_MATURING';
  accountId: string;
  maturesOn: Day;
}

/** Daily check: cushion goes red with no open case. */
export interface ShortfallEvent extends AgentEventBase {
  type: 'SHORTFALL';
  lowest: Lowest;
}

/** The voice worker or dispatch. Moves the negotiation to the text channel. */
export interface CallFailedEvent extends AgentEventBase {
  type: 'CALL_FAILED';
  callId: string;
  negotiationId?: string;
  reason: 'sip_error' | 'ended_without_outcome' | 'forced' | 'worker_error';
  sipStatus?: string;
}

/** The voice worker. A call record; PIN gate. */
export interface InboundCallEvent extends AgentEventBase {
  type: 'INBOUND_CALL';
  callId: string;
  room: string;
  callerPhone: string;
}

/**
 * Addition (not in the §5.1 table): emitted by code when a call or text negotiation closes,
 * so the case can move to SUMMARIZING and run post_call_summary.
 */
export interface CallEndedEvent extends AgentEventBase {
  type: 'CALL_ENDED';
  callId: string;
  negotiationId?: string;
}

/**
 * Addition: emitted by request_approval's timer (60 s for mid-call deals) and by the watcher's
 * 30-minute demo-clock reminders, so the case can react without polling.
 */
export interface ApprovalTimeoutEvent extends AgentEventBase {
  type: 'APPROVAL_TIMEOUT';
  approvalId: string;
  caseId?: string;
  reminder: boolean; // true = send a reminder text, the approval stays pending
}

export type AgentEvent =
  | BillPhotoEvent
  | ChoiceReplyEvent
  | ApprovalReplyEvent
  | BillCorrectionEvent
  | TextEvent
  | DailyCheckEvent
  | CdMaturingEvent
  | ShortfallEvent
  | CallFailedEvent
  | InboundCallEvent
  | CallEndedEvent
  | ApprovalTimeoutEvent;

export type AgentEventType = AgentEvent['type'];

export const AGENT_EVENT_TYPES = [
  'BILL_PHOTO',
  'CHOICE_REPLY',
  'APPROVAL_REPLY',
  'BILL_CORRECTION',
  'TEXT',
  'DAILY_CHECK',
  'CD_MATURING',
  'SHORTFALL',
  'CALL_FAILED',
  'INBOUND_CALL',
  'CALL_ENDED',
  'APPROVAL_TIMEOUT',
] as const satisfies readonly AgentEventType[];

/** Events that open a new case. */
export const CASE_STARTING_EVENTS = ['BILL_PHOTO', 'CD_MATURING', 'SHORTFALL'] as const satisfies readonly AgentEventType[];

/** Distributive Omit so each member keeps its own fields. */
export type AgentEventInput = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, 'id' | 'at'> : never) : never;

// ---------------------------------------------------------------------------
// Server-sent events (SPEC §4). GET /api/events, every message has `id: <seq>`.
// ---------------------------------------------------------------------------

export interface CaseSnapshot {
  case: Case;
  /** null until the planner has written the plan. */
  plan: Plan | null;
  /** Addition: the case's bill (merchant, amount, due day), for "If you pay the $650 repair today". null for CD and shortfall cases. */
  bill?: Bill | null;
}

export interface SseEventMap {
  activity: ActivityEvent;
  thread: Message;
  forecast: Forecast; // after any accepted change
  scores: HealthScore[];
  case: CaseSnapshot;
  call: Call; // on status change and each transcript line
  approval: Approval;
  clock: { day: Day };
  arena: ArenaProgress;
  /** Addition: on every negotiation change (offers, checks, state), for the panel's offer rows and the lender console. */
  negotiation: Negotiation;
  /** Addition: after PUT /api/rules. */
  rules: Rules;
  /** Addition: after POST /api/demo/reset; the dashboard refetches GET /api/snapshot. */
  reset: { day: Day };
}

export type SseEventName = keyof SseEventMap;

export const SSE_EVENT_NAMES = [
  'activity',
  'thread',
  'forecast',
  'scores',
  'case',
  'call',
  'approval',
  'clock',
  'arena',
  'negotiation',
  'rules',
  'reset',
] as const satisfies readonly SseEventName[];

/** One SSE message as the bus publishes it. `seq` is the SSE `id:` line. */
export type SseEvent = {
  [K in SseEventName]: { event: K; seq: number; data: SseEventMap[K] };
}[SseEventName];

/** What a producer passes to bus.publish(); the bus assigns seq. */
export type SseEventInput = {
  [K in SseEventName]: { event: K; data: SseEventMap[K] };
}[SseEventName];
