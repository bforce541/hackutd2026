/**
 * SPEC §5.6: the 14 tools. Input and output schemas are zod; the same definitions become the
 * JSON schemas sent to Nemotron (see toOpenAITool). Every call emits tool.called and tool.result
 * (apps/server/src/tools/registry.ts does that).
 * Owned by Ram.
 */
import { z } from 'zod';
import {
  AccountSchema,
  ApprovalKindSchema,
  CallPlanSchema,
  CategorySchema,
  CentsSchema,
  ChangeSchema,
  DaySchema,
  DecideResultSchema,
  ForecastSchema,
  HealthScoreSchema,
  LowestSchema,
  OptionIdSchema,
  NetWorthSchema,
  OfferCheckSchema,
  RulesSchema,
  SecondOpinionSchema,
  WeekdaySchema,
} from './schemas';
import { TOOL_NAMES } from './constants';
import type { ToolName } from './types';

export { TOOL_NAMES };
export type { ToolName };

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

export const GetAccountsInput = z.object({});
export const GetAccountsOutput = z.object({
  byCategory: z.record(CategorySchema, z.array(AccountSchema)),
  netWorth: NetWorthSchema,
});

/** A forecast day without open/flags, to keep model context small. */
export const CompactForecastDaySchema = z.object({
  day: DaySchema,
  date: z.string(),
  weekday: WeekdaySchema,
  close: CentsSchema,
  intradayLow: CentsSchema,
  items: z.array(z.object({ label: z.string(), amount: CentsSchema })),
});
export type CompactForecastDay = z.infer<typeof CompactForecastDaySchema>;

export const GetForecastInput = z.object({ days: z.number().int().positive().max(60).optional() });
export const GetForecastOutput = z.object({
  lowest: ForecastSchema.shape.lowest,
  days: z.array(CompactForecastDaySchema),
  scores: z.array(HealthScoreSchema),
});

// simulate takes friendly what-ifs that tools/simulate.ts turns into engine Changes (the model can't
// build Change objects reliably). Days are words ("today", "Friday", "Nov 13"), amounts are dollars.
// Raw engine Changes are still accepted in `changes` (validated with ChangeSchema in the tool).
const Dollars = z.union([z.number(), z.string()]);
const DayWord = z.coerce.string();
export const SimulateInput = z.object({
  spend: z
    .object({
      amount_dollars: Dollars.describe('Dollars, e.g. 800'),
      day: DayWord.optional().describe('today (default), tomorrow, a weekday like Friday, or a date like Nov 13'),
      from: z.string().optional().describe("'checking' (default) or 'card'"),
    })
    .optional()
    .describe('A purchase or expense he is thinking about.'),
  move_payment: z
    .object({
      item: z.string().describe("Which payment, e.g. 'car payment' or 'personal loan'"),
      to_day: DayWord.describe('A weekday like Friday, or a date like Nov 13'),
    })
    .optional()
    .describe('Move a due date to a later day.'),
  paycheck_late_days: z.number().optional().describe('The next paycheck arrives this many days late.'),
  transfer: z
    .object({
      amount_dollars: Dollars,
      from: z.string().optional().describe("'savings' (default) or 'checking'"),
      to: z.string().optional().describe("'checking' (default), 'savings' or 'card'"),
      day: DayWord.optional().describe('today (default), tomorrow, a weekday, or a date'),
    })
    .optional()
    .describe('Move money between his own accounts.'),
  changes: z.array(z.unknown()).optional().describe('Advanced: raw engine changes. Leave out; use the fields above.'),
});
export const SimulateOutput = z.object({
  /** Lowest checking balance over the next 60 days with the what-if applied (cents) and the day it happens. */
  lowest: LowestSchema,
  /** The lowest point's date as text, e.g. 'Tue, Nov 10'. */
  lowestOn: z.string().optional(),
  /** below_zero: overdrawn; below_minimum: under his checking minimum; ok. */
  status: z.enum(['below_zero', 'below_minimum', 'ok']).optional(),
  /** His checking minimum (cents). */
  minimum: CentsSchema.optional(),
  /** The same lowest point without the what-if. */
  without: z.object({ lowest: LowestSchema, lowestOn: z.string() }).optional(),
  /** What was simulated, in words, with the dollar amount (cents) and date for each. */
  applied: z.array(z.object({ what: z.string(), amount: CentsSchema.optional(), on: z.string().optional() })).optional(),
  scores: z.array(HealthScoreSchema),
  netWorth: NetWorthSchema,
});

export const CheckOfferInput = z.object({
  itemId: z.string(),
  newDay: DaySchema,
  fee: CentsSchema.nonnegative(),
});
export const CheckOfferOutput = OfferCheckSchema;

export const GetTermsInput = z.object({ counterpartyId: z.string(), question: z.string() });
export const GetTermsOutput = z.object({
  passages: z.array(z.object({ docId: z.string(), text: z.string(), score: z.number() })),
});

export const ReadBillInput = z.object({ mediaId: z.string() });
export const ReadBillOutput = z.object({
  merchant: z.string(),
  amount: CentsSchema,
  dueDay: DaySchema.nullable(),
  description: z.string(),
  confidence: z.number().min(0).max(1),
  crossCheck: z
    .object({ agrees: z.boolean(), amount: CentsSchema.optional(), dueDay: DaySchema.optional() })
    .optional(),
});

export const SecondOpinionInput = z.object({ callPlan: CallPlanSchema, rules: RulesSchema, script: z.string() });
export const SecondOpinionOutput = SecondOpinionSchema;

export const SendMessageInput = z.object({
  text: z.string().min(1),
  /** Every $ amount and % in `text` must appear in a value here (SPEC §5.5). */
  facts: z.record(z.string(), z.string()),
});
export const SendMessageOutput = z.object({ messageId: z.string() });

export const SendChartInput = z.object({
  kind: z.enum(['week', 'what_if']),
  changes: z.array(ChangeSchema).optional(),
});
export const SendChartOutput = z.object({ messageId: z.string(), mediaId: z.string() });

export const RequestApprovalInput = z.object({
  kind: ApprovalKindSchema,
  prompt: z.string().min(1),
  choices: z.array(z.string()).min(1),
  /** option_choice only: the option order as texted; reply "n" maps to optionIds[n-1] (SPEC §2). */
  optionIds: z.array(OptionIdSchema).optional(),
  timeoutMs: z.number().int().positive().optional(),
  callId: z.string().optional(),
  /** deal only: the negotiation the offer belongs to (text mode has no callId). */
  negotiationId: z.string().optional(),
});
export const RequestApprovalOutput = z.object({ approvalId: z.string() });

export const PlaceCallInput = z.object({ negotiationId: z.string() });
export const PlaceCallOutput = z.object({ callId: z.string(), room: z.string() });

export const DecideInput = z.object({ negotiationId: z.string(), utterance: z.string() });
export const DecideOutput = DecideResultSchema;

export const PostCallSummaryInput = z.object({ callId: z.string() });
export const PostCallSummaryOutput = z.object({
  messageId: z.string(),
  summary: z.string(),
  referenceNumber: z.string().optional(),
});

export const ScheduleFollowupInput = z.object({ atDay: DaySchema, text: z.string().min(1) });
export const ScheduleFollowupOutput = z.object({ followupId: z.string() });

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

export type ToolCaller = 'orchestrator' | 'qa' | 'negotiator' | 'voice' | 'lender_console' | 'arena';

export interface ToolSpec<
  N extends ToolName = ToolName,
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: N;
  description: string; // shown to the model
  input: I;
  output: O;
  calledBy: readonly ToolCaller[];
  /** true when a model may call it directly (it goes into the `tools` array sent to Nemotron). */
  modelCallable: boolean;
}

function spec<const N extends ToolName, I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  s: ToolSpec<N, I, O>,
): ToolSpec<N, I, O> {
  return s;
}

export const TOOLS = {
  get_accounts: spec({
    name: 'get_accounts',
    description: "Every account grouped by PNC category, plus net worth. Amounts are integer cents.",
    input: GetAccountsInput,
    output: GetAccountsOutput,
    calledBy: ['orchestrator', 'qa'],
    modelCallable: true,
  }),
  get_forecast: spec({
    name: 'get_forecast',
    description: 'Checking balance by day with every accepted change applied, the lowest point and its causes, and the four health scores. Amounts are integer cents.',
    input: GetForecastInput,
    output: GetForecastOutput,
    calledBy: ['orchestrator', 'qa'],
    modelCallable: true,
  }),
  simulate: spec({
    name: 'simulate',
    description: "Run the engine on a what-if and return the lowest checking balance and its date (with and without the what-if), whether it dips below $0 or his minimum, scores and net worth. Fill in the fields you need (spend, move_payment, paycheck_late_days, transfer); days are words like 'today' or 'Friday', amounts are dollars. Changes nothing.",
    input: SimulateInput,
    output: SimulateOutput,
    calledBy: ['orchestrator', 'qa'],
    modelCallable: true,
  }),
  check_offer: spec({
    name: 'check_offer',
    description: "Check a lender's offer (new day and fee in cents) against the forecast and Yoshua's rules.",
    input: CheckOfferInput,
    output: CheckOfferOutput,
    calledBy: ['negotiator'],
    modelCallable: false,
  }),
  get_terms: spec({
    name: 'get_terms',
    description: "Look up passages from a lender's or biller's terms (grace period, late fee, whether due dates can move).",
    input: GetTermsInput,
    output: GetTermsOutput,
    calledBy: ['orchestrator'],
    modelCallable: true,
  }),
  read_bill: spec({
    name: 'read_bill',
    description: 'Read a bill photo: merchant, amount in cents, due day, description and confidence.',
    input: ReadBillInput,
    output: ReadBillOutput,
    calledBy: ['orchestrator'],
    modelCallable: true,
  }),
  second_opinion: spec({
    name: 'second_opinion',
    description: 'Ask Claude to review a call plan and script against the rules before calling.',
    input: SecondOpinionInput,
    output: SecondOpinionOutput,
    calledBy: ['orchestrator'],
    modelCallable: true,
  }),
  send_message: spec({
    name: 'send_message',
    description: "Text Yoshua. Every dollar amount and percentage in text must appear in facts.",
    input: SendMessageInput,
    output: SendMessageOutput,
    calledBy: ['orchestrator', 'qa'],
    modelCallable: true,
  }),
  send_chart: spec({
    name: 'send_chart',
    description: "Send Yoshua a chart image of the week, or of a what-if with changes.",
    input: SendChartInput,
    output: SendChartOutput,
    calledBy: ['orchestrator'],
    modelCallable: true,
  }),
  request_approval: spec({
    name: 'request_approval',
    description: "Text Yoshua a question that needs his answer (a numbered choice or YES/NO) and wait for the reply.",
    input: RequestApprovalInput,
    output: RequestApprovalOutput,
    calledBy: ['orchestrator', 'negotiator'],
    modelCallable: true,
  }),
  place_call: spec({
    name: 'place_call',
    description: 'Dispatch the voice agent and dial the lender for a negotiation. Refused unless Yoshua picked the call option and approved the limits.',
    input: PlaceCallInput,
    output: PlaceCallOutput,
    calledBy: ['orchestrator'],
    modelCallable: true,
  }),
  decide: spec({
    name: 'decide',
    description: "The negotiator's reply to one thing the lender said.",
    input: DecideInput,
    output: DecideOutput,
    calledBy: ['voice', 'lender_console', 'arena'],
    modelCallable: false,
  }),
  post_call_summary: spec({
    name: 'post_call_summary',
    description: 'Text Yoshua a 2-3 line summary of a finished call, with the reference number.',
    input: PostCallSummaryInput,
    output: PostCallSummaryOutput,
    calledBy: ['orchestrator'],
    modelCallable: true,
  }),
  schedule_followup: spec({
    name: 'schedule_followup',
    description: 'Schedule a text to Yoshua for a later demo day (e.g. the night-before reminder).',
    input: ScheduleFollowupInput,
    output: ScheduleFollowupOutput,
    calledBy: ['orchestrator'],
    modelCallable: true,
  }),
} as const satisfies { [K in ToolName]: ToolSpec<K> };

export type Tools = typeof TOOLS;
export type ToolInput<N extends ToolName> = z.infer<Tools[N]['input']>;
export type ToolOutput<N extends ToolName> = z.infer<Tools[N]['output']>;

/** Tools offered to the orchestrator and Q&A models. */
export const MODEL_TOOL_NAMES = TOOL_NAMES.filter((n) => TOOLS[n].modelCallable);

/** Q&A (answer_question, inbound /ask) may only read. */
export const QA_TOOL_NAMES = ['get_accounts', 'get_forecast', 'simulate'] as const satisfies readonly ToolName[];

/** OpenAI chat-completions `tools` entry for one tool, from its zod input schema. */
export function toOpenAITool(name: ToolName): {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
} {
  const t = TOOLS[name];
  const parameters = z.toJSONSchema(t.input, { target: 'draft-7' }) as Record<string, unknown>;
  delete parameters.$schema;
  return { type: 'function', function: { name: t.name, description: t.description, parameters } };
}
