/**
 * zod mirrors of the types that cross HTTP or model boundaries. Each schema is checked against
 * its TypeScript type with `satisfies z.ZodType<T>`, so the two cannot drift.
 * Owned by Ram.
 */
import { z } from 'zod';
import {
  ACCOUNT_KINDS,
  ACTIVITY_TYPES,
  APPROVAL_KINDS,
  ARENA_PERSONAS,
  CASE_STATES,
  CATEGORIES,
  ITEM_KINDS,
  MODEL_ROLES,
  NEGOTIATION_STATES,
  OFFER_REASONS,
  OPTION_IDS,
  RULE_VIOLATIONS,
  SCORE_KEYS,
  STEP_KINDS,
  TOOL_NAMES,
  WEEKDAYS,
} from './constants';
import type * as T from './types';
import type * as A from './api';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const CentsSchema = z.number().int();
export const DaySchema = z.number().int();
export const ISODateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const TimestampSchema = z.string();
export const HHMMSchema = z.string().regex(/^\d{2}:\d{2}$/);

export const CategorySchema = z.enum(CATEGORIES);
export const AccountKindSchema = z.enum(ACCOUNT_KINDS);
export const ItemKindSchema = z.enum(ITEM_KINDS);
export const WeekdaySchema = z.enum(WEEKDAYS);
export const ScoreKeySchema = z.enum(SCORE_KEYS);
export const ColorSchema = z.enum(['green', 'yellow', 'red']);
export const OptionIdSchema = z.enum(OPTION_IDS);
export const RuleViolationSchema = z.enum(RULE_VIOLATIONS);
export const OfferReasonSchema = z.enum(OFFER_REASONS);
export const ApprovalKindSchema = z.enum(APPROVAL_KINDS);
export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'declined', 'answered', 'timeout']);
export const NegotiationStateSchema = z.enum(NEGOTIATION_STATES);
export const StepKindSchema = z.enum(STEP_KINDS);
export const ModelRoleSchema = z.enum(MODEL_ROLES);
export const CaseStateSchema = z.enum(CASE_STATES);
export const ActivityTypeSchema = z.enum(ACTIVITY_TYPES);
export const ToolNameSchema = z.enum(TOOL_NAMES);
export const ArenaPersonaSchema = z.enum(ARENA_PERSONAS);
export const SpeakerSchema = z.enum(['pacepay', 'counterparty', 'customer']);
export const CallOutcomeSchema = z.enum(['deal', 'no_deal', 'handoff_verification', 'approval_timeout', 'failed', 'qa']);
export const CallStatusSchema = z.enum(['dispatching', 'ringing', 'active', 'holding_for_approval', 'ended', 'failed']);

// ---------------------------------------------------------------------------
// Household
// ---------------------------------------------------------------------------

export const AccountSchema = z.object({
  id: z.string(),
  kind: AccountKindSchema,
  category: CategorySchema,
  name: z.string(),
  isLiability: z.boolean(),
  balance: CentsSchema,
  apr: z.number().optional(),
  apy: z.number().optional(),
  limit: CentsSchema.optional(),
  minPayment: CentsSchema.optional(),
  maturesOn: DaySchema.optional(),
  offLimits: z.boolean().optional(),
  reference: z.string().optional(),
  assetValue: CentsSchema.optional(),
}) satisfies z.ZodType<T.Account>;

export const RecurrenceSchema = z.union([
  z.object({ days: z.number().int().positive() }),
  z.object({ months: z.number().int().positive() }),
]) satisfies z.ZodType<T.Recurrence>;

export const ScheduledItemSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  label: z.string(),
  amount: CentsSchema,
  counterAccountId: z.string().optional(),
  counterAmount: CentsSchema.optional(),
  day: DaySchema,
  every: RecurrenceSchema.optional(),
  kind: ItemKindSchema,
  counterpartyId: z.string().optional(),
  movable: z.boolean().optional(),
}) satisfies z.ZodType<T.ScheduledItem>;

export const RulesSchema = z.object({
  checkingFloor: CentsSchema.nonnegative(),
  savingsFloor: CentsSchema.nonnegative(),
  feeLimit: CentsSchema.nonnegative(),
  offLimitsAccountIds: z.array(z.string()),
  quietHours: z.object({ start: HHMMSchema, end: HHMMSchema }).optional(),
  paused: z.boolean().optional(),
}) satisfies z.ZodType<T.Rules>;

export const CounterpartySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['auto_lender', 'card_issuer', 'mortgage_servicer', 'utility', 'other']),
  phoneEnv: z.literal('LENDER_PHONE'),
  termsDocIds: z.array(z.string()),
}) satisfies z.ZodType<T.Counterparty>;

export const HouseholdSchema = z.object({
  id: z.string(),
  person: z.object({ name: z.literal('Yoshua'), phoneEnv: z.literal('CUSTOMER_PHONE') }),
  day0Date: ISODateSchema,
  grossAnnualIncome: CentsSchema,
  monthlyEssentials: z.array(z.object({ label: z.string(), amount: CentsSchema })),
  accounts: z.array(AccountSchema),
  scheduled: z.array(ScheduledItemSchema),
  rules: RulesSchema,
  counterparties: z.array(CounterpartySchema),
}) satisfies z.ZodType<T.Household>;

export const NetWorthSchema = z.object({
  assets: CentsSchema,
  liabilities: CentsSchema,
  netWorth: CentsSchema,
}) satisfies z.ZodType<T.NetWorth>;

// ---------------------------------------------------------------------------
// Forecast and scores
// ---------------------------------------------------------------------------

export const LowestSchema = z.object({ amount: CentsSchema, day: DaySchema }) satisfies z.ZodType<T.Lowest>;

export const ForecastDaySchema = z.object({
  day: DaySchema,
  date: ISODateSchema,
  weekday: WeekdaySchema,
  open: CentsSchema,
  close: CentsSchema,
  intradayLow: CentsSchema,
  items: z.array(z.object({ itemId: z.string(), label: z.string(), amount: CentsSchema })),
  belowFloor: z.boolean(),
  negative: z.boolean(),
}) satisfies z.ZodType<T.ForecastDay>;

export const ForecastSchema = z.object({
  accountId: z.string(),
  days: z.array(ForecastDaySchema),
  lowest: LowestSchema.extend({ causeItemIds: z.array(z.string()) }),
}) satisfies z.ZodType<T.Forecast>;

export const HealthScoreSchema = z.object({
  key: ScoreKeySchema,
  value: z.number(),
  display: z.string(),
  color: ColorSchema,
  reason: z.string(),
  improve: z.string(),
}) satisfies z.ZodType<T.HealthScore>;

// ---------------------------------------------------------------------------
// Changes, options, offers
// ---------------------------------------------------------------------------

export const ChangeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add_item'), item: ScheduledItemSchema }),
  z.object({ type: z.literal('move_item'), itemId: z.string(), toDay: DaySchema }),
  z.object({ type: z.literal('add_fee'), day: DaySchema, amount: CentsSchema, label: z.string() }),
  z.object({ type: z.literal('transfer'), fromAccountId: z.string(), toAccountId: z.string(), amount: CentsSchema, day: DaySchema }),
  z.object({ type: z.literal('charge_card'), accountId: z.string(), amount: CentsSchema, day: DaySchema, label: z.string() }),
  z.object({ type: z.literal('delay_item'), itemId: z.string(), days: z.number().int() }),
  z.object({ type: z.literal('pay_down'), fromAccountId: z.string(), toAccountId: z.string(), amount: CentsSchema, day: DaySchema }),
]) satisfies z.ZodType<T.Change>;

export const OptionTradeoffsSchema = z.object({
  monthlyInterest: CentsSchema.nullable(),
  creditUseBefore: z.number().nullable(),
  creditUseAfter: z.number().nullable(),
  savingsAfter: CentsSchema.nullable(),
  emergencyMonthsBefore: z.number().nullable(),
  emergencyMonthsAfter: z.number().nullable(),
  yearlyInterestSaved: CentsSchema.nullable(),
  yearlyInterestEarned: CentsSchema.nullable(),
}) satisfies z.ZodType<T.OptionTradeoffs>;

export const OptionSchema = z.object({
  id: OptionIdSchema,
  label: z.string(),
  changes: z.array(ChangeSchema),
  lowest: LowestSchema,
  tradeoffs: OptionTradeoffsSchema,
  violations: z.array(RuleViolationSchema),
}) satisfies z.ZodType<T.Option>;

export const OfferSchema = z.object({
  id: z.string(),
  negotiationId: z.string(),
  itemId: z.string(),
  newDay: DaySchema,
  fee: CentsSchema,
  heard: z.string(),
  readBackConfirmed: z.boolean(),
}) satisfies z.ZodType<T.Offer>;

export const OfferCheckSchema = z.object({
  offerId: z.string(),
  pass: z.boolean(),
  affordable: z.boolean(),
  withinLimits: z.boolean(),
  postsOnDay: DaySchema,
  lowest: LowestSchema,
  reasons: z.array(OfferReasonSchema),
}) satisfies z.ZodType<T.OfferCheck>;

// ---------------------------------------------------------------------------
// Approvals, calls, negotiations
// ---------------------------------------------------------------------------

export const ApprovalSchema = z.object({
  id: z.string(),
  kind: ApprovalKindSchema,
  prompt: z.string(),
  choices: z.array(z.string()),
  optionIds: z.array(OptionIdSchema).optional(),
  status: ApprovalStatusSchema,
  answer: z.string().optional(),
  callId: z.string().optional(),
  caseId: z.string().optional(),
  negotiationId: z.string().optional(),
  requestedAt: TimestampSchema,
  resolvedAt: TimestampSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  previousTerms: z.object({ newDay: DaySchema, fee: CentsSchema }).optional(),
  newTerms: z.object({ newDay: DaySchema, fee: CentsSchema }).optional(),
}) satisfies z.ZodType<T.Approval>;

export const TranscriptLineSchema = z.object({
  at: TimestampSchema,
  speaker: SpeakerSchema,
  text: z.string(),
}) satisfies z.ZodType<T.TranscriptLine>;

export const CallSchema = z.object({
  id: z.string(),
  direction: z.enum(['outbound', 'inbound']),
  counterpartyId: z.string().optional(),
  phone: z.string(),
  room: z.string(),
  status: CallStatusSchema,
  negotiationId: z.string().optional(),
  pinVerified: z.boolean().optional(),
  transcript: z.array(TranscriptLineSchema),
  outcome: CallOutcomeSchema.optional(),
  referenceNumber: z.string().optional(),
  summary: z.string().optional(),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.optional(),
}) satisfies z.ZodType<T.Call>;

export const CallPlanSchema = z.object({
  goal: z.string(),
  targetDay: DaySchema,
  acceptableDays: z.array(DaySchema),
  feeLimit: CentsSchema,
  openingAsk: z.string(),
  walkAway: z.string(),
  fallbackText: z.string(),
}) satisfies z.ZodType<T.CallPlan>;

export const NegotiationSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  counterpartyId: z.string(),
  itemId: z.string(),
  channel: z.enum(['voice', 'text']),
  callPlan: CallPlanSchema,
  offers: z.array(OfferSchema),
  pendingOfferId: z.string().optional(),
  state: NegotiationStateSchema,
  outcome: CallOutcomeSchema.optional(),
  checks: z.array(OfferCheckSchema).optional(),
  transcript: z.array(TranscriptLineSchema).optional(),
  referenceNumber: z.string().optional(),
  callId: z.string().optional(),
  termsChange: z
    .object({
      kind: z.enum(['terms', 'extra_fee', 'condition', 'walkback']),
      previousTerms: z.object({ newDay: DaySchema, fee: CentsSchema }),
      newTerms: z.object({ newDay: DaySchema, fee: CentsSchema }).optional(),
      afterApproval: z.boolean(),
      status: z.enum(['asking_lender', 'awaiting_yoshua', 'yoshua_approved', 'yoshua_declined', 'resolved', 'no_deal']),
      approvalId: z.string().optional(),
      at: TimestampSchema,
    })
    .optional(),
  closeReason: z.string().optional(),
}) satisfies z.ZodType<T.Negotiation>;

export const DecideResultSchema = z.object({
  say: z.string(),
  next: z.enum(['listen', 'await_approval', 'end_call']),
  state: NegotiationStateSchema,
  dtmf: z.string().optional(),
}) satisfies z.ZodType<T.DecideResult>;

// ---------------------------------------------------------------------------
// Plans, cases, bills
// ---------------------------------------------------------------------------

export const PlanStepSchema = z.object({
  id: z.string(),
  kind: StepKindSchema,
  title: z.string(),
  model: ModelRoleSchema,
  status: z.enum(['pending', 'running', 'done', 'skipped', 'failed', 'blocked']),
  note: z.string().optional(),
  startedAt: TimestampSchema.optional(),
  endedAt: TimestampSchema.optional(),
}) satisfies z.ZodType<T.PlanStep>;

export const PlanSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  eventId: z.string(),
  goal: z.string(),
  author: z.enum(['nemotron-ultra', 'template']),
  writtenBy: ModelRoleSchema.optional(),
  steps: z.array(PlanStepSchema),
}) satisfies z.ZodType<T.Plan>;

export const CaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: CaseStateSchema,
  planId: z.string().optional(),
  billId: z.string().optional(),
  chosenOption: OptionIdSchema.optional(),
  negotiationId: z.string().optional(),
  approvalIds: z.array(z.string()),
  kind: z.enum(['bill', 'cd_maturing', 'shortfall']).optional(),
  options: z.array(OptionSchema).optional(),
  baseChanges: z.array(ChangeSchema).optional(),
  acceptedChanges: z.array(ChangeSchema).optional(),
  review: z
    .object({
      verdict: z.enum(['approve', 'revise', 'skipped']),
      revisionApplied: z.boolean().optional(),
      issues: z.array(z.object({ severity: z.enum(['high', 'low']), issue: z.string(), fix: z.string() })),
      at: TimestampSchema,
    })
    .optional(),
  callId: z.string().optional(),
  openedAt: TimestampSchema.optional(),
  closedAt: TimestampSchema.optional(),
}) satisfies z.ZodType<T.Case>;

export const BillSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  mediaId: z.string().optional(),
  merchant: z.string(),
  amount: CentsSchema,
  dueDay: DaySchema.nullable(),
  description: z.string(),
  confidence: z.number().min(0).max(1),
  crossCheck: z.object({ agrees: z.boolean(), amount: CentsSchema.optional(), dueDay: DaySchema.optional() }).optional(),
  confirmed: z.boolean(),
  source: z.enum(['photo', 'fixture', 'typed', 'correction']),
}) satisfies z.ZodType<T.Bill>;

// ---------------------------------------------------------------------------
// Messages, activity, follow-ups, arena
// ---------------------------------------------------------------------------

export const MessageSchema = z.object({
  id: z.string(),
  direction: z.enum(['in', 'out']),
  channel: z.enum(['imessage', 'dashboard']),
  text: z.string().optional(),
  imageUrl: z.string().optional(),
  at: TimestampSchema,
}) satisfies z.ZodType<T.Message>;

export const ActivityEventSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  at: TimestampSchema,
  type: ActivityTypeSchema,
  caseId: z.string().optional(),
  planId: z.string().optional(),
  stepId: z.string().optional(),
  model: ModelRoleSchema.optional(),
  tool: ToolNameSchema.optional(),
  title: z.string(),
  detail: z.unknown().optional(),
  level: z.enum(['info', 'warn', 'error']).optional(),
  ms: z.number().optional(),
}) satisfies z.ZodType<T.ActivityEvent>;

export const FollowupSchema = z.object({
  id: z.string(),
  caseId: z.string().optional(),
  atDay: DaySchema,
  atTime: HHMMSchema.optional(),
  text: z.string(),
  status: z.enum(['scheduled', 'sent', 'cancelled']),
  sentAt: TimestampSchema.optional(),
}) satisfies z.ZodType<T.Followup>;

export const ArenaRunSchema = z.object({
  id: z.string(),
  persona: z.string(),
  transcript: z.array(TranscriptLineSchema),
  offerChecks: z.array(OfferCheckSchema),
  grade: z.union([z.record(z.string(), z.unknown()), z.literal('ungraded'), z.literal('errored')]),
  outcome: CallOutcomeSchema.optional(),
  lenderName: z.string().optional(),
}) satisfies z.ZodType<T.ArenaRun>;

export const ArenaResultsSchema = z.object({
  runId: z.string(),
  total: z.number().int(),
  dealRate: z.number(),
  limitViolations: z.number().int(),
  disclosures: z.number().int(),
  readBackRate: z.number(),
  runs: z.array(ArenaRunSchema),
  sample: z.boolean().optional(),
}) satisfies z.ZodType<T.ArenaResults>;

// ---------------------------------------------------------------------------
// Model boundaries: what each model must return, validated before code uses it
// ---------------------------------------------------------------------------

/** SPEC §5.2: the planner's JSON. Code assigns ids, status and caseId. */
export const PlannerOutputSchema = z.object({
  goal: z.string().min(1),
  steps: z
    .array(z.object({ kind: StepKindSchema, title: z.string().min(1), model: ModelRoleSchema }))
    .min(1),
});
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

/** SPEC §8.3: Nano's classification of one lender utterance. `fee` is in dollars as heard. */
export const NegotiatorClassificationSchema = z.object({
  kind: z.enum(['offer', 'confirm', 'deny', 'question', 'verification_request', 'refusal', 'chitchat']),
  offer: z.object({ day: z.string(), fee: z.number().nullable().optional() }).nullable().optional(),
  say: z.string().optional(),
});
export type NegotiatorClassification = z.infer<typeof NegotiatorClassificationSchema>;

/** SPEC §8.5: Claude's review of a call plan. */
export const SecondOpinionSchema = z.object({
  verdict: z.enum(['approve', 'revise']),
  issues: z.array(z.object({ severity: z.enum(['high', 'low']), issue: z.string(), fix: z.string() })),
});
export type SecondOpinion = z.infer<typeof SecondOpinionSchema>;

/** SPEC §8.7: Claude's arena grade. */
export const ArenaGradeSchema = z.object({
  deal_reached: z.boolean(),
  final_terms: z.object({ day: z.string().nullable(), fee: z.number().nullable() }),
  within_limits: z.boolean(),
  limit_violation: z.boolean(),
  disclosure: z.boolean(),
  read_back_every_offer: z.boolean(),
  approval_before_accepting: z.boolean(),
  honest_no_deal: z.boolean().nullable(),
  notes: z.string(),
}) satisfies z.ZodType<T.ArenaGrade>;

/**
 * What the vision model (and the Claude cross-check) return for a bill photo. Amounts are in
 * dollars as printed and the due date is as printed; code converts to cents and a Day.
 */
export const BillReadSchema = z.object({
  merchant: z.string(),
  amountDollars: z.number(),
  dueDate: z.string().nullable(), // as printed, or 'today' / 'at pickup'
  description: z.string(),
  confidence: z.number().min(0).max(1),
});
export type BillRead = z.infer<typeof BillReadSchema>;

// ---------------------------------------------------------------------------
// HTTP request bodies (the server validates every one)
// ---------------------------------------------------------------------------

export const SimulateRequestSchema = z.object({ changes: z.array(ChangeSchema) }) satisfies z.ZodType<A.SimulateRequest>;
export const PutRulesRequestSchema = RulesSchema;
export const PostThreadRequestSchema = z.object({ text: z.string().min(1) }) satisfies z.ZodType<A.PostThreadRequest>;
export const ResolveApprovalRequestSchema = z.object({ answer: z.string().min(1) }) satisfies z.ZodType<A.ResolveApprovalRequest>;
export const ArenaRunRequestSchema = z.object({
  count: z.number().int().positive().max(200),
  concurrency: z.number().int().positive().max(16).optional(),
  live: z.boolean().optional(),
}) satisfies z.ZodType<A.ArenaRunRequest>;
export const DemoClockRequestSchema = z.union([
  z.object({ day: DaySchema.nonnegative() }),
  z.object({ advance: z.number().int() }),
]) satisfies z.ZodType<A.DemoClockRequest>;
export const DemoBillPhotoRequestSchema = z.object({ fixture: z.literal('brake_quote') }) satisfies z.ZodType<A.DemoBillPhotoRequest>;
export const DemoCustomerSaysRequestSchema = z.object({ text: z.string().min(1) }) satisfies z.ZodType<A.DemoCustomerSaysRequest>;
export const LenderSaysRequestSchema = z.object({ text: z.string().min(1) }) satisfies z.ZodType<A.LenderSaysRequest>;
export const VoiceDecideRequestSchema = z.object({ utterance: z.string() }) satisfies z.ZodType<A.VoiceDecideRequest>;
export const VoiceCallEventRequestSchema = z.object({
  type: z.enum(['answered', 'transcript', 'ended', 'failed']),
  speaker: SpeakerSchema.optional(),
  text: z.string().optional(),
  sipStatus: z.string().optional(),
}) satisfies z.ZodType<A.VoiceCallEventRequest>;
export const VoiceInboundRequestSchema = z.object({ room: z.string(), callerPhone: z.string() }) satisfies z.ZodType<A.VoiceInboundRequest>;
export const VoiceVerifyPinRequestSchema = z.object({ digits: z.string() }) satisfies z.ZodType<A.VoiceVerifyPinRequest>;
export const VoiceAskRequestSchema = z.object({ question: z.string() }) satisfies z.ZodType<A.VoiceAskRequest>;

// Responses the voice worker parses (it trusts nothing it did not validate).
export const VoiceBriefResponseSchema = z.object({
  direction: z.enum(['outbound', 'inbound']),
  greeting: z.string(),
  goal: z.string(),
  personName: z.literal('Yoshua'),
  accountReference: z.string(),
  counterpartyName: z.string().optional(),
}) satisfies z.ZodType<A.VoiceBriefResponse>;
export const VoiceApprovalResponseSchema = z.object({
  status: z.enum(['pending', 'approved', 'declined', 'timeout']),
  say: z.string().optional(),
  next: z.enum(['listen', 'end_call']).optional(),
  prepare: z.array(z.string()).optional(),
}) satisfies z.ZodType<A.VoiceApprovalResponse>;
export const VoiceInboundResponseSchema = z.object({
  callId: z.string(),
  greeting: z.string(),
  requirePin: z.boolean(),
}) satisfies z.ZodType<A.VoiceInboundResponse>;
export const VoiceVerifyPinResponseSchema = z.object({ ok: z.boolean(), say: z.string() }) satisfies z.ZodType<A.VoiceVerifyPinResponse>;
export const VoiceAskResponseSchema = z.object({ say: z.string() }) satisfies z.ZodType<A.VoiceAskResponse>;
