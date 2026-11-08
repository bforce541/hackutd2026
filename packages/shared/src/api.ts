/**
 * HTTP contracts (SPEC §4). Every request and response body the server and its clients exchange.
 * Base URL: SERVER_URL (default http://localhost:8787). JSON in and out.
 * Owned by Ram. Additions beyond SPEC §4 are marked "Addition:".
 */
import type {
  Account,
  Approval,
  ApprovalStatus,
  ArenaResults,
  Bill,
  Call,
  CallDirection,
  Case,
  Category,
  Change,
  Day,
  DecideResult,
  Forecast,
  HealthScore,
  Household,
  Message,
  Negotiation,
  NegotiationState,
  NetWorth,
  Plan,
  Rules,
  Speaker,
} from './types';

export const DEFAULT_SERVER_URL = 'http://localhost:8787';
export const DEFAULT_DASHBOARD_URL = 'http://localhost:3000';
export const SERVER_PORT = 8787;
export const DASHBOARD_PORT = 3000;

/** Every error response: a 4xx or 5xx with this body. */
export interface ApiError {
  error: { code: string; message: string };
}

export type ApiErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'forbidden' // /api/voice/* from a non-localhost address
  | 'read_only' // addition: a write through the public tunnel (the public dashboard is view-only)
  | 'conflict' // e.g. a gate in machine.ts refused the transition
  | 'not_implemented'
  | 'internal';

export interface OkResponse {
  ok: true;
}

// ---------------------------------------------------------------------------
// Dashboard reads and writes
// ---------------------------------------------------------------------------

/** GET /api/household */
export interface HouseholdResponse {
  household: Household;
  netWorth: NetWorth;
  byCategory: Record<Category, Account[]>;
}

/** GET /api/forecast?days=60 : checking, with every accepted change applied. */
export type ForecastResponse = Forecast;
export interface ForecastQuery {
  days?: number;
}

/** GET /api/scores */
export type ScoresResponse = HealthScore[];

/** POST /api/simulate */
export interface SimulateRequest {
  changes: Change[];
}
export interface SimulateResponse {
  forecast: Forecast;
  scores: HealthScore[];
  netWorth: NetWorth;
}

/** GET /api/rules, PUT /api/rules */
export type RulesResponse = Rules;
export type PutRulesRequest = Rules;

/** GET /api/thread : the iMessage thread mirror. */
export type ThreadResponse = Message[];

/** POST /api/thread : coach chat, treated exactly like a text from Yoshua. */
export interface PostThreadRequest {
  text: string;
}
export type PostThreadResponse = OkResponse;

/** GET /api/cases/current */
export type CurrentCaseResponse =
  | { case: Case; plan: Plan | null; approvals: Approval[]; bill: Bill | null }
  | { case: null };

/** GET /api/calls/:id */
export type CallResponse = Call;

/** GET /api/media/:id returns image bytes (bill photos and chart PNGs). */
export const mediaUrl = (id: string): string => `/api/media/${encodeURIComponent(id)}`;

/** GET /api/arena */
export type ArenaResponse = ArenaResults;

/** POST /api/arena/run (progress over SSE `arena`). */
export interface ArenaRunRequest {
  count: number;
  concurrency?: number;
  live?: boolean;
}
export interface ArenaRunResponse {
  runId: string;
}

/**
 * Addition: POST /api/approvals/:id resolves a pending approval from a dashboard button
 * (Call now, Approve, Decline, an option row). Handled exactly as if Yoshua texted `answer`.
 */
export interface ResolveApprovalRequest {
  answer: string; // '1' | '2' | '3' | 'yes' | 'no'
}
export type ResolveApprovalResponse = OkResponse;

/**
 * Addition: GET /api/snapshot returns everything the dashboard needs on first load and after
 * a `reset` SSE event, so it does not have to make nine requests.
 */
export interface SnapshotResponse {
  household: Household;
  netWorth: NetWorth;
  byCategory: Record<Category, Account[]>;
  forecast: Forecast; // 60 days from today, store.forecastChanges() applied
  scores: HealthScore[];
  /** Addition: every change the current forecast applies (accepted changes plus the open case's baseChanges). */
  acceptedChanges: Change[];
  rules: Rules;
  thread: Message[];
  current: CurrentCaseResponse;
  call: Call | null; // the current case's call, if any
  negotiation: Negotiation | null;
  day: Day; // the demo clock
  arena: ArenaResults | null;
  lastSeq: number; // pass as Last-Event-ID when opening /api/events
}

// ---------------------------------------------------------------------------
// Demo controls
// ---------------------------------------------------------------------------

/** POST /api/demo/reset */
export type DemoResetResponse = OkResponse;

/** POST /api/demo/clock */
export type DemoClockRequest = { day: Day } | { advance: number };
export interface DemoClockResponse {
  day: Day;
}

/** POST /api/demo/bill-photo : JSON fixture, or multipart with an `image` file field. */
export interface DemoBillPhotoRequest {
  fixture: 'brake_quote';
}
export type DemoBillPhotoResponse = OkResponse;

/** POST /api/demo/customer-says */
export interface DemoCustomerSaysRequest {
  text: string;
}
export type DemoCustomerSaysResponse = OkResponse;

/** Addition: POST /api/demo/fail-call forces CALL_FAILED on the active call ("Call dropped? Switch to text"). */
export type DemoFailCallResponse = OkResponse;

// ---------------------------------------------------------------------------
// Lender console (text negotiation; the call's fallback)
// ---------------------------------------------------------------------------

/** POST /api/negotiations/:id/lender */
export interface LenderSaysRequest {
  text: string;
}
export interface LenderSaysResponse {
  reply: string;
  state: NegotiationState;
  awaitingApproval: boolean;
}

/** GET /api/negotiations/:id */
export type NegotiationResponse = Negotiation;

// ---------------------------------------------------------------------------
// Voice worker endpoints (localhost only)
// ---------------------------------------------------------------------------

/** GET /api/voice/calls/:id/brief : allowlisted fields only, never balances or limits. */
export interface VoiceBriefResponse {
  direction: CallDirection;
  greeting: string;
  goal: string;
  personName: 'Yoshua';
  accountReference: string;
  counterpartyName?: string;
}

/** POST /api/voice/calls/:id/decide */
export interface VoiceDecideRequest {
  utterance: string;
}
export type VoiceDecideResponse = DecideResult;

/** POST /api/voice/calls/:id/approval (the worker polls this every 2 s for up to 60 s). */
export interface VoiceApprovalResponse {
  status: Extract<ApprovalStatus, 'pending' | 'approved' | 'declined' | 'timeout'>;
  say?: string;
  next?: 'listen' | 'end_call';
  /** While pending: the lines PacePay may say next (the approved line's wordings, the hold lines), for the worker to synthesize ahead. */
  prepare?: string[];
}

/** POST /api/voice/calls/:id/events -> 204 */
export interface VoiceCallEventRequest {
  type: 'answered' | 'transcript' | 'ended' | 'failed';
  speaker?: Speaker;
  text?: string;
  sipStatus?: string;
}

/** POST /api/voice/inbound */
export interface VoiceInboundRequest {
  room: string;
  callerPhone: string;
}
export interface VoiceInboundResponse {
  callId: string;
  greeting: string;
  requirePin: boolean;
}

/** POST /api/voice/calls/:id/verify-pin */
export interface VoiceVerifyPinRequest {
  digits: string;
}
export interface VoiceVerifyPinResponse {
  ok: boolean;
  say: string;
}

/** POST /api/voice/calls/:id/ask : inbound Q&A; numbers allowed only after the PIN. */
export interface VoiceAskRequest {
  question: string;
}
export interface VoiceAskResponse {
  say: string;
}

// ---------------------------------------------------------------------------
// Paths, so clients never hand-build a URL
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;

export const API = {
  household: '/api/household',
  forecast: (days = 60) => `/api/forecast?days=${days}`,
  scores: '/api/scores',
  simulate: '/api/simulate',
  rules: '/api/rules',
  thread: '/api/thread',
  currentCase: '/api/cases/current',
  call: (id: string) => `/api/calls/${enc(id)}`,
  approval: (id: string) => `/api/approvals/${enc(id)}`,
  media: mediaUrl,
  arena: '/api/arena',
  arenaRun: '/api/arena/run',
  snapshot: '/api/snapshot',
  events: '/api/events',
  demo: {
    reset: '/api/demo/reset',
    clock: '/api/demo/clock',
    billPhoto: '/api/demo/bill-photo',
    customerSays: '/api/demo/customer-says',
    failCall: '/api/demo/fail-call',
  },
  negotiation: (id: string) => `/api/negotiations/${enc(id)}`,
  lenderSays: (id: string) => `/api/negotiations/${enc(id)}/lender`,
  voice: {
    brief: (callId: string) => `/api/voice/calls/${enc(callId)}/brief`,
    decide: (callId: string) => `/api/voice/calls/${enc(callId)}/decide`,
    approval: (callId: string) => `/api/voice/calls/${enc(callId)}/approval`,
    events: (callId: string) => `/api/voice/calls/${enc(callId)}/events`,
    inbound: '/api/voice/inbound',
    verifyPin: (callId: string) => `/api/voice/calls/${enc(callId)}/verify-pin`,
    ask: (callId: string) => `/api/voice/calls/${enc(callId)}/ask`,
  },
  health: '/api/health',
} as const;

/** Addition: GET /api/health for boot checks and the dashboard's live/demo probe. */
export interface HealthResponse {
  ok: true;
  day: Day;
  provider: 'gateway' | 'nvidia' | 'none';
  agent: 'stub' | 'real';
  /** Addition: true when this request came through the public tunnel. The server is view-only there: every write returns 403 `read_only`. */
  readOnly?: boolean;
}
