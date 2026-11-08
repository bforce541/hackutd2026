/**
 * PacePay data model. SPEC §2 is the source; this file is the frozen contract.
 * Owned by Ram. Change it only after telling Yoshua (SPEC rule 3).
 *
 * Money is integer cents. Days are integers counted from demo day 0 (a Saturday).
 * Additions beyond SPEC §2 are marked "Addition:" with the reason.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type Cents = number; // integer
export type Day = number; // 0 = demo day 0
export type ISODate = string; // 'YYYY-MM-DD'
export type ISOTimestamp = string; // new Date().toISOString()

// ---------------------------------------------------------------------------
// Accounts and the household
// ---------------------------------------------------------------------------

/** PNC's six categories, in display order. */
export type Category = 'checking' | 'savings' | 'cds_iras' | 'loans' | 'credit_cards' | 'mortgage';

export type AccountKind =
  | 'checking'
  | 'savings'
  | 'cd'
  | 'ira'
  | 'auto_loan'
  | 'personal_loan'
  | 'credit_card'
  | 'mortgage';

export interface Account {
  id: string;
  kind: AccountKind;
  category: Category; // cd + ira -> cds_iras; auto_loan + personal_loan -> loans
  name: string;
  isLiability: boolean;
  balance: Cents; // assets: money held; liabilities: amount owed (both positive)
  apr?: number; // 0.2499
  apy?: number; // CDs
  limit?: Cents; // credit cards
  minPayment?: Cents; // monthly minimum or installment
  maturesOn?: Day; // CDs
  offLimits?: boolean; // the IRA by default
  reference?: string; // e.g. 'ending 4417', the only account detail said on calls
  assetValue?: Cents; // home value on the mortgage account
}

export type ItemKind =
  | 'paycheck'
  | 'bill'
  | 'loan_payment'
  | 'card_autopay'
  | 'transfer'
  | 'fee'
  | 'one_time'
  | 'card_spend'; // everyday spending charged to the card (see v2.md)

export type Recurrence = { days: number } | { months: number };

export interface ScheduledItem {
  id: string;
  accountId: string; // the account it posts to (bills post to checking, card_spend to the card)
  label: string;
  amount: Cents; // signed change to that account's `balance` (on a liability, + means more owed)
  counterAccountId?: string; // set when money moves between Yoshua's own accounts
  counterAmount?: Cents; // signed change to the counter account's `balance` (card autopay: checking -, card -)
  day: Day; // first occurrence
  every?: Recurrence;
  kind: ItemKind;
  counterpartyId?: string; // e.g. the auto lender
  movable?: boolean; // can a negotiation move it
}

export interface QuietHours {
  start: string; // 'HH:MM'
  end: string; // 'HH:MM'
}

export interface Rules {
  checkingFloor: Cents;
  savingsFloor: Cents;
  feeLimit: Cents;
  offLimitsAccountIds: string[];
  quietHours?: QuietHours;
  /** Addition: the Accounts tab's "Pause PacePay" switch (UI.md). When true, PacePay sends nothing unprompted. */
  paused?: boolean;
}

export type CounterpartyKind = 'auto_lender' | 'card_issuer' | 'mortgage_servicer' | 'utility' | 'other';

export interface Counterparty {
  id: string;
  name: string; // fictional
  kind: CounterpartyKind;
  phoneEnv: 'LENDER_PHONE'; // the demo always dials the team's lender phone
  termsDocIds: string[]; // for get_terms
}

export interface Household {
  id: string;
  person: { name: 'Yoshua'; phoneEnv: 'CUSTOMER_PHONE' };
  day0Date: ISODate; // a Saturday
  grossAnnualIncome: Cents;
  monthlyEssentials: { label: string; amount: Cents }[];
  accounts: Account[];
  scheduled: ScheduledItem[];
  rules: Rules;
  counterparties: Counterparty[];
}

export interface NetWorth {
  assets: Cents;
  liabilities: Cents;
  netWorth: Cents;
}

// ---------------------------------------------------------------------------
// Forecast and scores
// ---------------------------------------------------------------------------

export type Weekday = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

export interface ForecastItem {
  itemId: string;
  label: string;
  amount: Cents;
}

export interface ForecastDay {
  day: Day;
  date: ISODate;
  weekday: Weekday;
  open: Cents;
  close: Cents;
  intradayLow: Cents; // deposits post before debits on the same day: min(open, close)
  items: ForecastItem[];
  belowFloor: boolean; // intradayLow < checkingFloor
  negative: boolean; // intradayLow < 0
}

export interface Lowest {
  amount: Cents;
  day: Day;
}

export interface Forecast {
  accountId: string;
  days: ForecastDay[];
  lowest: Lowest & { causeItemIds: string[] }; // causes = debits on or before the lowest day, since the last credit
}

export type ScoreKey = 'cash_cushion' | 'emergency_fund' | 'credit_use' | 'debt_to_income';
export type Color = 'green' | 'yellow' | 'red';

export interface HealthScore {
  key: ScoreKey;
  value: number; // cents for cash_cushion, months, or a ratio
  display: string; // '$100', '0.6 months', '56%', '35.5%'
  color: Color;
  reason: string; // one line, generated by the engine from templates
  improve: string; // one line
}

// ---------------------------------------------------------------------------
// Changes, options, offers
// ---------------------------------------------------------------------------

export type Change =
  | { type: 'add_item'; item: ScheduledItem }
  | { type: 'move_item'; itemId: string; toDay: Day }
  | { type: 'add_fee'; day: Day; amount: Cents; label: string }
  | { type: 'transfer'; fromAccountId: string; toAccountId: string; amount: Cents; day: Day }
  | { type: 'charge_card'; accountId: string; amount: Cents; day: Day; label: string }
  | { type: 'delay_item'; itemId: string; days: number }
  | { type: 'pay_down'; fromAccountId: string; toAccountId: string; amount: Cents; day: Day };

export type ChangeType = Change['type'];

export type OptionId = 'card' | 'savings' | 'move_payment' | 'cd_renew' | 'cd_payoff_card';

export type RuleViolation =
  | 'BELOW_CHECKING_FLOOR'
  | 'BELOW_SAVINGS_FLOOR'
  | 'USES_OFF_LIMITS_ACCOUNT'
  | 'FEE_OVER_LIMIT';

export interface OptionTradeoffs {
  // every number the text may quote; null when not relevant
  monthlyInterest: Cents | null;
  creditUseBefore: number | null;
  creditUseAfter: number | null;
  savingsAfter: Cents | null;
  emergencyMonthsBefore: number | null;
  emergencyMonthsAfter: number | null;
  yearlyInterestSaved: Cents | null;
  yearlyInterestEarned: Cents | null;
}

export interface Option {
  id: OptionId;
  label: string;
  changes: Change[];
  lowest: Lowest;
  tradeoffs: OptionTradeoffs;
  violations: RuleViolation[]; // e.g. savings below floor
}

export interface Offer {
  id: string;
  negotiationId: string;
  itemId: string; // the scheduled item being moved
  newDay: Day;
  fee: Cents;
  heard: string; // the lender's exact words
  readBackConfirmed: boolean; // set only after the lender confirms the read-back
}

export type OfferReason =
  | 'OK'
  | 'NEGATIVE_BALANCE' // intraday low < 0 somewhere in the next 30 days
  | 'BELOW_FLOOR' // intraday low < checking floor
  | 'PAYDAY_SAME_DAY' // new day is a payday: risky by rule
  | 'FEE_OVER_LIMIT' // affordable, but fee > feeLimit
  | 'WEEKEND_ROLLS_FORWARD' // informational: a weekend day posts on the next business day
  | 'UNKNOWN_ITEM';

export interface OfferCheck {
  offerId: string;
  pass: boolean; // affordable && withinLimits && !PAYDAY_SAME_DAY
  affordable: boolean;
  withinLimits: boolean;
  postsOnDay: Day; // after weekend roll-forward
  lowest: Lowest;
  reasons: OfferReason[];
}

// ---------------------------------------------------------------------------
// Approvals, calls, negotiations
// ---------------------------------------------------------------------------

export type ApprovalKind = 'option_choice' | 'call_limits' | 'deal' | 'bill_confirm';
export type ApprovalStatus = 'pending' | 'approved' | 'declined' | 'answered' | 'timeout';

export interface Approval {
  id: string;
  kind: ApprovalKind;
  prompt: string; // the exact text sent to Yoshua
  choices: string[]; // ['1','2','3'] or ['yes','no']
  optionIds?: OptionId[]; // option_choice only: the order shown to Yoshua; reply "n" maps to optionIds[n-1]
  status: ApprovalStatus;
  answer?: string;
  callId?: string;
  /** Addition: the case this approval belongs to, so a reply can be routed without a lookup. */
  caseId?: string;
  /** Addition: deal approvals only. Set in both channels (a text negotiation has no callId). */
  negotiationId?: string;
  requestedAt: ISOTimestamp;
  resolvedAt?: ISOTimestamp;
  timeoutMs?: number; // 60_000 for mid-call deals
  /** Addition: deal re-approvals only (the lender changed the terms): what Yoshua approved or was asked before. */
  previousTerms?: DealTerms;
  /** Addition: deal re-approvals only: the lender's new terms this approval asks about. */
  newTerms?: DealTerms;
}

export type Speaker = 'pacepay' | 'counterparty' | 'customer';

export interface TranscriptLine {
  at: ISOTimestamp;
  speaker: Speaker;
  text: string;
}

export type CallDirection = 'outbound' | 'inbound';
export type CallStatus = 'dispatching' | 'ringing' | 'active' | 'holding_for_approval' | 'ended' | 'failed';
export type CallOutcome = 'deal' | 'no_deal' | 'handoff_verification' | 'approval_timeout' | 'failed' | 'qa';

export interface Call {
  id: string;
  direction: CallDirection;
  counterpartyId?: string;
  phone: string; // E.164
  room: string; // LiveKit room, 'photon-<id>' (matches the dispatch rule's prefix)
  status: CallStatus;
  negotiationId?: string;
  pinVerified?: boolean; // inbound only
  transcript: TranscriptLine[];
  outcome?: CallOutcome;
  referenceNumber?: string;
  summary?: string;
  startedAt: ISOTimestamp;
  endedAt?: ISOTimestamp;
}

export interface CallPlan {
  goal: string; // 'Move the auto payment from day 3 to a day after payday'
  targetDay: Day; // first acceptable day, chosen by the engine
  acceptableDays: Day[]; // every day check_offer passes with fee 0
  feeLimit: Cents; // never said out loud
  openingAsk: string; // e.g. ask to move with no fee
  walkAway: string; // when to stop
  fallbackText: string; // what to text Yoshua on no deal
}

export type NegotiationState =
  | 'opening'
  | 'listening'
  | 'reading_back'
  | 'countering'
  | 'awaiting_approval'
  | 'closed';

export type NegotiationChannel = 'voice' | 'text'; // text = the lender console fallback and the arena

export interface Negotiation {
  id: string;
  caseId: string;
  counterpartyId: string;
  itemId: string;
  channel: NegotiationChannel;
  callPlan: CallPlan;
  offers: Offer[];
  pendingOfferId?: string; // heard, read back, waiting for the lender's confirmation
  state: NegotiationState;
  outcome?: CallOutcome;
  /** Addition: engine verdicts, one per checked offer (same order as checking), for the panel's offer rows. */
  checks?: OfferCheck[];
  /**
   * Addition: the negotiator's own record of the conversation, in both channels (the lender's
   * utterances passed to decide and every line decide returned). For a voice call, Call.transcript
   * (posted by the worker to /events) is what the dashboard shows; for text mode and the arena,
   * this is the only transcript.
   */
  transcript?: TranscriptLine[];
  /** Addition: the reference number the lender gave (both channels); copied to Call.referenceNumber for calls. */
  referenceNumber?: string;
  /** Addition: the call carrying this negotiation, once place_call ran. */
  callId?: string;
  /**
   * Addition: the lender changed (or conditioned) terms PacePay was holding them to: during the
   * hold for Yoshua's answer, or after he approved. Stays on the negotiation once set (the
   * dashboard's "lender changed the terms" screen reads it). See negotiator.ts header.
   */
  termsChange?: TermsChange;
  /** Addition: why the negotiation closed without a deal, in plain words (set on every no-deal close the negotiator can explain). */
  closeReason?: string;
}

/** Addition: a day and a fee, as the lender offered them or Yoshua approved them. */
export interface DealTerms {
  newDay: Day;
  fee: Cents;
}

/** Addition: the lender changed the terms (Negotiation.termsChange). */
export interface TermsChange {
  /** 'terms': a new day and/or fee; 'extra_fee': a fee added on top; 'condition': a non-money condition; 'walkback': took the offer back. */
  kind: 'terms' | 'extra_fee' | 'condition' | 'walkback';
  /** What PacePay holds the lender to: the terms Yoshua approved (or was being asked about). */
  previousTerms: DealTerms;
  /** The lender's new terms, when they named a day and fee. */
  newTerms?: DealTerms;
  /** Yoshua had already said yes to previousTerms when the lender changed them. */
  afterApproval: boolean;
  /**
   * 'asking_lender': PacePay asked the lender to honor previousTerms;
   * 'awaiting_yoshua': the lender insisted, newTerms are within limits, Yoshua got a fresh approval (approvalId);
   * 'yoshua_approved' / 'yoshua_declined': his answer to that fresh approval;
   * 'resolved': the lender went back to previousTerms;
   * 'no_deal': PacePay closed without a deal because of the change (closeReason says why).
   */
  status: 'asking_lender' | 'awaiting_yoshua' | 'yoshua_approved' | 'yoshua_declined' | 'resolved' | 'no_deal';
  /** The fresh deal approval sent to Yoshua for newTerms. */
  approvalId?: string;
  at: ISOTimestamp;
}

/** SPEC §4: the negotiator's answer to one counterparty utterance. */
export interface DecideResult {
  say: string; // the exact words to speak
  next: 'listen' | 'await_approval' | 'end_call';
  state: NegotiationState;
  /** Addition: DTMF digits to send on the call (an IVR menu), when the transport can; send instead of speaking `say`. */
  dtmf?: string;
}

// ---------------------------------------------------------------------------
// Plans and cases
// ---------------------------------------------------------------------------

export type StepKind =
  | 'read_bill'
  | 'forecast'
  | 'build_options'
  | 'send_options'
  | 'await_choice'
  | 'get_terms'
  | 'plan_call'
  | 'confirm_limits'
  | 'second_opinion'
  | 'place_call'
  | 'negotiate'
  | 'confirm_deal'
  | 'post_call_summary'
  | 'update_forecast'
  | 'schedule_followup'
  | 'send_message'
  | 'answer_question'
  | 'cd_options';

/** Who ran a step or made a call: the label on every activity feed row. */
export type ModelRole =
  | 'nemotron-ultra'
  | 'nemotron-super'
  | 'nemotron-nano'
  | 'nemotron-vision'
  | 'claude-opus'
  | 'gpt-realtime'
  | 'negotiator'
  | 'engine'
  | 'code';

export type PlanStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'blocked';

export interface PlanStep {
  id: string;
  kind: StepKind;
  title: string; // shown in the activity feed checklist
  model: ModelRole;
  status: PlanStepStatus;
  note?: string;
  startedAt?: ISOTimestamp;
  endedAt?: ISOTimestamp;
}

export interface Plan {
  id: string;
  caseId: string;
  eventId: string;
  goal: string;
  author: 'nemotron-ultra' | 'template'; // template = fallback when Ultra fails validation twice
  /** Addition: the model that actually wrote it (Super when Ultra is unavailable), for the Activity tab label. */
  writtenBy?: ModelRole;
  steps: PlanStep[];
}

/** SPEC §5.3. A bill_confirm wait happens inside ANALYZING (the read_bill step). */
export type CaseState =
  | 'NEW'
  | 'ANALYZING'
  | 'OPTIONS_SENT'
  | 'AWAITING_CHOICE'
  | 'ADVISED'
  | 'PREPARING_CALL'
  | 'AWAITING_LIMITS'
  | 'REVIEWING'
  | 'CALLING'
  | 'NEGOTIATING'
  | 'AWAITING_APPROVAL'
  | 'CONFIRMING'
  | 'HOLD_REQUESTED'
  | 'TEXT_NEGOTIATION'
  | 'SUMMARIZING'
  | 'DONE';

export type CaseKind = 'bill' | 'cd_maturing' | 'shortfall';

/** Addition: the second_opinion result the place_call gate reads (SPEC §5.3). */
export interface CaseReview {
  /** 'skipped' = timed out or Claude unavailable (logged as warn); the gate lets it through. */
  verdict: 'approve' | 'revise' | 'skipped';
  /** For 'revise': true once the orchestrator applied the fixes to the call plan. */
  revisionApplied?: boolean;
  issues: { severity: 'high' | 'low'; issue: string; fix: string }[];
  at: ISOTimestamp;
}

export interface Case {
  // one problem being worked, e.g. "the $650 repair"
  id: string;
  title: string;
  state: CaseState; // section 5.3
  planId?: string;
  billId?: string;
  chosenOption?: OptionId;
  negotiationId?: string;
  approvalIds: string[];
  /** Addition: which event family opened the case (drives the template plan and the panel). */
  kind?: CaseKind;
  /** Addition: options as ranked and shown to Yoshua (option 1 first). */
  options?: Option[];
  /**
   * Addition: the case's own change while it is open, e.g. the bill paid from checking on its due
   * day (v2.md: once the quote is in, the forecast counts it as paid from checking today). The
   * server's current forecast applies store.acceptedChanges plus the open case's baseChanges
   * (store.forecastChanges()); check_offer and planCallTargets pass that as ctx.baseChanges.
   * A BILL_CORRECTION replaces it. When the case commits these to acceptedChanges (deal confirmed,
   * or the case closes), clear baseChanges in the same store update so nothing counts twice.
   */
  baseChanges?: Change[];
  /**
   * Addition: changes this case committed to the store's acceptedChanges (e.g. the bill, the moved
   * payment and its fee), for the dashboard's "moved payment" tint. A record; the store's list is
   * what forecasts apply.
   */
  acceptedChanges?: Change[];
  /** Addition: the second_opinion result (place_call gate). */
  review?: CaseReview;
  /** Addition: the call placed for this case, if any. */
  callId?: string;
  openedAt?: ISOTimestamp;
  closedAt?: ISOTimestamp;
}

/**
 * Addition: the bill read from a photo (read_bill's "stores the bill on the case").
 * Unconfirmed from the ack until Yoshua's next non-correction reply (SPEC §5.1).
 */
export interface Bill {
  id: string;
  caseId: string;
  mediaId?: string;
  merchant: string;
  amount: Cents;
  dueDay: Day | null;
  description: string;
  confidence: number; // 0..1
  crossCheck?: { agrees: boolean; amount?: Cents; dueDay?: Day };
  confirmed: boolean;
  source: 'photo' | 'fixture' | 'typed' | 'correction';
}

// ---------------------------------------------------------------------------
// Messages and the activity feed
// ---------------------------------------------------------------------------

export type MessageDirection = 'in' | 'out';
export type MessageChannel = 'imessage' | 'dashboard';

export interface Message {
  id: string;
  direction: MessageDirection;
  channel: MessageChannel;
  text?: string;
  imageUrl?: string; // served from /api/media/:id
  at: ISOTimestamp;
}

export type ActivityType =
  | 'event.received'
  | 'plan.created'
  | 'step.started'
  | 'step.completed'
  | 'step.skipped'
  | 'step.failed'
  | 'tool.called'
  | 'tool.result'
  | 'model.called'
  | 'message.in'
  | 'message.out'
  | 'approval.requested'
  | 'approval.resolved'
  | 'call.dispatched'
  | 'call.answered'
  | 'call.transcript'
  | 'call.ended'
  | 'call.failed'
  | 'offer.heard'
  | 'offer.read_back'
  | 'offer.confirmed'
  | 'offer.checked'
  | 'review.result'
  | 'forecast.updated'
  | 'scores.updated'
  | 'arena.progress'
  | 'arena.completed'
  | 'demo.reset'
  | 'clock.changed';

export type ActivityLevel = 'info' | 'warn' | 'error';

/** Who did it, for the Activity log's "who" column: a model role, or Yoshua himself. */
export type Actor = ModelRole | 'yoshua';

export interface ActivityEvent {
  id: string;
  seq: number; // monotonically increasing; the dashboard reorders by it
  at: ISOTimestamp;
  type: ActivityType;
  caseId?: string;
  planId?: string;
  stepId?: string;
  model?: ModelRole; // label shown on every feed row
  tool?: ToolName;
  title: string; // one plain line: 'Nemotron Nano checked "Friday, $20 fee": pass'
  detail?: unknown; // raw inputs/outputs, collapsed in the UI
  level?: ActivityLevel;
  ms?: number; // duration for model and tool calls
}

/** What a producer passes to bus.emit(); the bus fills id, seq and at. */
export type ActivityInput = Omit<ActivityEvent, 'id' | 'seq' | 'at'> & { at?: ISOTimestamp };

// ---------------------------------------------------------------------------
// Tools and model jobs
// ---------------------------------------------------------------------------

/** SPEC §5.6: the 14 tools. Schemas live in tools.ts. */
export type ToolName =
  | 'get_accounts'
  | 'get_forecast'
  | 'simulate'
  | 'check_offer'
  | 'get_terms'
  | 'read_bill'
  | 'second_opinion'
  | 'send_message'
  | 'send_chart'
  | 'request_approval'
  | 'place_call'
  | 'decide'
  | 'post_call_summary'
  | 'schedule_followup';

/**
 * Addition: the job a model call does. apps/server/src/models picks the concrete model and
 * provider per job (SPEC §5.4) and reports the ModelRole that actually ran it.
 */
export type ModelJob = 'planner' | 'orchestrator' | 'decide' | 'vision' | 'claude' | 'embed' | 'image' | 'tts';

export type ModelProvider = 'gateway' | 'nvidia';

// ---------------------------------------------------------------------------
// Follow-ups and the arena
// ---------------------------------------------------------------------------

/** Addition: a schedule_followup entry; the watcher sends it when the clock passes atDay. */
export interface Followup {
  id: string;
  caseId?: string;
  atDay: Day;
  /** 'HH:MM' local demo time, e.g. '20:00' for the night-before reminder. Display only. */
  atTime?: string;
  text: string;
  status: 'scheduled' | 'sent' | 'cancelled';
  sentAt?: ISOTimestamp;
}

export type ArenaPersona =
  | 'cooperative'
  | 'fee_pusher'
  | 'stubborn_dates'
  | 'vague'
  | 'flat_refusal'
  | 'identity_check'
  | 'chatty';

/** Addition: the grade object Claude returns (SPEC §8.7). */
export interface ArenaGrade {
  deal_reached: boolean;
  final_terms: { day: string | null; fee: number | null };
  within_limits: boolean;
  limit_violation: boolean;
  disclosure: boolean;
  read_back_every_offer: boolean;
  approval_before_accepting: boolean;
  honest_no_deal: boolean | null;
  notes: string;
}

export interface ArenaRun {
  id: string;
  persona: string;
  transcript: TranscriptLine[];
  offerChecks: OfferCheck[];
  grade: Record<string, unknown> | 'ungraded' | 'errored';
  /** Addition: the run's outcome for the grid tile. */
  outcome?: CallOutcome;
  /** Addition: fictional lender name for the tile. */
  lenderName?: string;
}

export interface ArenaResults {
  runId: string;
  total: number;
  dealRate: number;
  limitViolations: number;
  disclosures: number;
  readBackRate: number;
  runs: ArenaRun[];
  /** Addition: true when these are the sample numbers shipped with the UI, not a real run. */
  sample?: boolean;
}

export interface ArenaProgress {
  runId: string;
  done: number;
  total: number;
  latest?: ArenaRun;
}
