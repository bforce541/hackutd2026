/**
 * Every string union from types.ts as a runtime list, checked for completeness at compile time.
 * The zod enums in schemas.ts and the display orders in the UI come from here.
 */
import type {
  AccountKind,
  ActivityType,
  ApprovalKind,
  ArenaPersona,
  CaseState,
  Category,
  ItemKind,
  ModelJob,
  ModelRole,
  NegotiationState,
  OfferReason,
  OptionId,
  RuleViolation,
  ScoreKey,
  StepKind,
  ToolName,
  Weekday,
} from './types';

/** Compile error unless A lists every member of T. */
type Exhaustive<T, A extends readonly T[]> = Exclude<T, A[number]> extends never ? A : never;
function all<T>() {
  return <const A extends readonly T[]>(a: Exhaustive<T, A>): A => a;
}

export const DEMO_DAY0: string = '2026-11-07'; // Sat, Nov 7 2026 (v2.md)
export const HORIZON_DAYS = 30; // scores and offer checks look 30 days ahead
export const CHART_DAYS = 60; // the chart shows up to 60
export const CHART_RANGES = [14, 30, 60] as const;
export type ChartRange = (typeof CHART_RANGES)[number];
export const CD_ALERT_DAY = 11; // Wed, Nov 18: the Skip button's target
export const DEAL_APPROVAL_TIMEOUT_MS = 60_000;
export const REMINDER_AFTER_DEMO_MINUTES = 30;

export const CATEGORIES = all<Category>()(['checking', 'savings', 'cds_iras', 'loans', 'credit_cards', 'mortgage']);

export const ACCOUNT_KINDS = all<AccountKind>()([
  'checking',
  'savings',
  'cd',
  'ira',
  'auto_loan',
  'personal_loan',
  'credit_card',
  'mortgage',
]);

export const ITEM_KINDS = all<ItemKind>()([
  'paycheck',
  'bill',
  'loan_payment',
  'card_autopay',
  'transfer',
  'fee',
  'one_time',
  'card_spend',
]);

/** Bank transfers roll weekends forward to the next business day; card_spend does not. */
export const BANK_TRANSFER_KINDS = ['paycheck', 'bill', 'loan_payment', 'card_autopay', 'transfer'] as const satisfies readonly ItemKind[];

export const WEEKDAYS = all<Weekday>()(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']); // Date.getUTCDay() order

export const SCORE_KEYS = all<ScoreKey>()(['cash_cushion', 'emergency_fund', 'credit_use', 'debt_to_income']);

export const OPTION_IDS = all<OptionId>()(['card', 'savings', 'move_payment', 'cd_renew', 'cd_payoff_card']);

export const RULE_VIOLATIONS = all<RuleViolation>()([
  'BELOW_CHECKING_FLOOR',
  'BELOW_SAVINGS_FLOOR',
  'USES_OFF_LIMITS_ACCOUNT',
  'FEE_OVER_LIMIT',
]);

export const OFFER_REASONS = all<OfferReason>()([
  'OK',
  'NEGATIVE_BALANCE',
  'BELOW_FLOOR',
  'PAYDAY_SAME_DAY',
  'FEE_OVER_LIMIT',
  'WEEKEND_ROLLS_FORWARD',
  'UNKNOWN_ITEM',
]);

export const APPROVAL_KINDS = all<ApprovalKind>()(['option_choice', 'call_limits', 'deal', 'bill_confirm']);

export const NEGOTIATION_STATES = all<NegotiationState>()([
  'opening',
  'listening',
  'reading_back',
  'countering',
  'awaiting_approval',
  'closed',
]);

export const STEP_KINDS = all<StepKind>()([
  'read_bill',
  'forecast',
  'build_options',
  'send_options',
  'await_choice',
  'get_terms',
  'plan_call',
  'confirm_limits',
  'second_opinion',
  'place_call',
  'negotiate',
  'confirm_deal',
  'post_call_summary',
  'update_forecast',
  'schedule_followup',
  'send_message',
  'answer_question',
  'cd_options',
]);

export const MODEL_ROLES = all<ModelRole>()([
  'nemotron-ultra',
  'nemotron-super',
  'nemotron-nano',
  'nemotron-vision',
  'claude-opus',
  'gpt-realtime',
  'negotiator',
  'engine',
  'code',
]);

export const MODEL_JOBS = all<ModelJob>()(['planner', 'orchestrator', 'decide', 'vision', 'claude', 'embed', 'image', 'tts']);

export const CASE_STATES = all<CaseState>()([
  'NEW',
  'ANALYZING',
  'OPTIONS_SENT',
  'AWAITING_CHOICE',
  'ADVISED',
  'PREPARING_CALL',
  'AWAITING_LIMITS',
  'REVIEWING',
  'CALLING',
  'NEGOTIATING',
  'AWAITING_APPROVAL',
  'CONFIRMING',
  'HOLD_REQUESTED',
  'TEXT_NEGOTIATION',
  'SUMMARIZING',
  'DONE',
]);

export const ACTIVITY_TYPES = all<ActivityType>()([
  'event.received',
  'plan.created',
  'step.started',
  'step.completed',
  'step.skipped',
  'step.failed',
  'tool.called',
  'tool.result',
  'model.called',
  'message.in',
  'message.out',
  'approval.requested',
  'approval.resolved',
  'call.dispatched',
  'call.answered',
  'call.transcript',
  'call.ended',
  'call.failed',
  'offer.heard',
  'offer.read_back',
  'offer.confirmed',
  'offer.checked',
  'review.result',
  'forecast.updated',
  'scores.updated',
  'arena.progress',
  'arena.completed',
  'demo.reset',
  'clock.changed',
]);

export const TOOL_NAMES = all<ToolName>()([
  'get_accounts',
  'get_forecast',
  'simulate',
  'check_offer',
  'get_terms',
  'read_bill',
  'second_opinion',
  'send_message',
  'send_chart',
  'request_approval',
  'place_call',
  'decide',
  'post_call_summary',
  'schedule_followup',
]);

export const ARENA_PERSONAS = all<ArenaPersona>()([
  'cooperative',
  'fee_pusher',
  'stubborn_dates',
  'vague',
  'flat_refusal',
  'identity_check',
  'chatty',
]);

/** SPEC §8.6: persona mix for 50 runs. */
export const ARENA_PERSONA_MIX: Record<ArenaPersona, number> = {
  cooperative: 10,
  fee_pusher: 10,
  stubborn_dates: 8,
  vague: 8,
  flat_refusal: 6,
  identity_check: 5,
  chatty: 3,
};

/** UI.md Arena tab: the persona word on each tile. */
export const ARENA_PERSONA_WORDS: Record<ArenaPersona, string> = {
  cooperative: 'Friendly',
  fee_pusher: 'Fees',
  stubborn_dates: 'Firm',
  vague: 'Vague',
  flat_refusal: 'No',
  identity_check: 'ID check',
  chatty: 'Chatty',
};

/**
 * SPEC §5.4: which ModelRole each step kind runs on. Plan validation (5.2 rule 1) checks
 * every step's `model` against this table. `negotiate` accepts Super until Nano passes.
 */
export const STEP_MODELS: Record<StepKind, readonly ModelRole[]> = {
  read_bill: ['nemotron-vision', 'nemotron-super'],
  forecast: ['engine'],
  build_options: ['engine'],
  send_options: ['nemotron-super'],
  await_choice: ['code'],
  get_terms: ['nemotron-super'],
  plan_call: ['nemotron-ultra', 'nemotron-super'],
  confirm_limits: ['code'],
  second_opinion: ['claude-opus'],
  place_call: ['code'],
  negotiate: ['nemotron-nano', 'nemotron-super'],
  confirm_deal: ['code'],
  post_call_summary: ['nemotron-super'],
  update_forecast: ['engine'],
  schedule_followup: ['code'],
  send_message: ['nemotron-super', 'code'],
  answer_question: ['nemotron-super'],
  cd_options: ['engine', 'nemotron-ultra', 'nemotron-super'],
};

/**
 * UI.md color roles, for code that cannot read the dashboard's CSS variables (the chart PNG in
 * apps/server/src/messaging/chart.ts). Keep in step with apps/dashboard/app/globals.css.
 */
export const COLORS = {
  page: '#F2F1ED',
  panel: '#FFFFFF',
  ink: '#1C1B19',
  muted: '#64615A',
  hairline: '#E0DED7',
  zeroLine: '#7A766D', // $0 line and bill markers
  beforeLine: '#8F8A80', // "Before" / "Current plan" ghost
  green: '#1C6B4A',
  greenTint: '#E6F0EA',
  vermilion: '#B83A0B', // overdrawn text and the low dot
  hatch: '#C2410C', // hatching lines below $0
  hatchBg: '#FBE8DF',
  ochreLine: '#A36A00', // the minimum line
  ochre: '#8A5A00', // limits text
} as const;

/** SPEC §6 / UI.md: the chart image sent in iMessage. */
export const CHART_PNG = { width: 1200, height: 800, days: 14 } as const;
