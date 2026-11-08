/**
 * The dashboard's contract: one DashboardState and one Actions interface.
 * Owned by: dash-shell. Every component takes ({ state, actions }) and nothing else.
 *
 * Both data sources produce this exact shape:
 * - live (lib/live.ts, dash-shell): built from GET /api/snapshot and the SSE stream.
 * - demo (lib/demo-machine.ts, dash-demo): a self-contained port of the mockup's renderVals().
 * So a component never knows which one it is reading.
 *
 * Money is integer cents and days are demo days; format with @pacepay/shared (formatMoney,
 * formatDate, ...). Components never compute forecast numbers themselves: the chart and the
 * what-if numbers arrive here already computed (by the engine in the browser or the server).
 */
import type {
  ActivityEvent,
  Account,
  Approval,
  ArenaProgress,
  ArenaResults,
  Bill,
  Call,
  Case,
  Change,
  Category,
  Cents,
  ChartRange,
  Day,
  Forecast,
  HealthScore,
  ISODate,
  Lowest,
  Message,
  Negotiation,
  NetWorth,
  OfferVerdict,
  OptionId,
  Plan,
  Rules,
  ScoreKey,
  TranscriptLine,
} from '@pacepay/shared';

export type Tab = 'home' | 'messages' | 'activity' | 'accounts' | 'arena';
export const TABS: { id: Tab; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'messages', label: 'Messages' },
  { id: 'activity', label: 'Activity' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'arena', label: 'Arena' },
];

export type DataMode = 'live' | 'demo';
export type Connection = 'connecting' | 'open' | 'reconnecting' | 'demo';

/** The four Home stats (UI.md): three scores plus net worth. Cash cushion lives in the status line. */
export type StatKey = Exclude<ScoreKey, 'cash_cushion'> | 'net_worth';

/** The what-if checkbox rows (UI.md "What-if"). */
export interface WhatIfToggles {
  car: boolean; // Move the car payment to Fri
  late: boolean; // Paycheck lands Mon, not Thu
  card: boolean; // Put the repair on your card
  cd: boolean; // Use the CD to pay off your card
}
export type WhatIfKey = keyof WhatIfToggles;

// ---------------------------------------------------------------------------
// Pieces of state
// ---------------------------------------------------------------------------

export interface UiState {
  tab: Tab;
  range: ChartRange; // 14 | 30 | 60, 14 by default
  presenter: boolean;
  statOpen: StatKey | null; // the stat whose why/improve line is open
  whatIfOpen: boolean;
  whatIf: WhatIfToggles;
  cdDismissed: boolean; // "Later" on the CD alert
}

export interface HouseholdSummary {
  personName: 'Yoshua';
  day0Date: ISODate;
  checkingAccountId: string;
  /** Checking balance today (the 40px number). */
  checkingBalance: Cents;
  netWorth: NetWorth;
  accountCount: number;
  accounts: Account[];
  byCategory: Record<Category, Account[]>;
  /** Monthly essentials total, for the emergency-fund line. */
  monthlyEssentials: Cents;
}

/** What the pace line draws right now. */
export interface ChartView {
  /** The main line (current plan, the offer being checked, or the what-if). Days from `today`. */
  line: Forecast;
  /** The gray dashed ghost: "Before" during a call or after the deal, "Current plan" in what-if. */
  ghost: { forecast: Forecast; label: 'Before' | 'Current plan' } | null;
  /** The dashed ochre minimum line. */
  floor: Cents;
  /** The status line above the chart, also the chart's text label (UI.md). */
  status: string;
  lowest: Lowest;
  /** Which situation produced the line; drives the status wording and the swatch. */
  mode: 'plan' | 'offer' | 'what_if' | 'done';
}

/** One row under "Other options" or the best fix on the Heads up step. */
export interface OptionRow {
  optionId: OptionId;
  title: string; // "Put it on your card"
  detail: string; // "About $14/mo interest"
}

/** One before -> after row on the Approve step. */
export interface CompareRow {
  label: string; // "Payment" | "Fee" | "Lowest"
  before: string; // "Tue, Nov 10"
  after: string; // "Fri, Nov 13"
}

/** The PacePay panel shows exactly one of these at a time (UI.md "One thing at a time"). */
export type PanelView =
  | { step: 'idle' } // nothing needs Yoshua
  | {
      step: 'heads_up';
      lowest: Lowest; // "−$300 on Tue, Nov 10"
      condition: string; // "If you pay the $650 repair today."
      best: OptionRow & { cta: string }; // "Move your car payment to Fri" / "Stays above $100. Fee up to $25." / "Ask my lender"
      others: OptionRow[];
      approvalId?: string; // live: the pending option_choice
    }
  | {
      step: 'limits';
      askFor: Day; // "Ask for: Fri, Nov 13"
      maxFee: Cents; // "Most in fees: $25"
      newCredit: string; // "None"
      approvalId?: string; // live: the pending call_limits
    }
  | { step: 'call' } // details in state.call
  | {
      step: 'approve';
      rows: CompareRow[];
      approvalId?: string; // live: the pending deal approval
      secondsLeft?: number; // of the 60 s mid-call window
    }
  | {
      step: 'done';
      coveredThrough: Day; // "Covered through Dec 7"
      results: { label: string; value: string }[]; // "Car payment" / "Fri, Nov 13"; the Reference row is added from `reference`
      reference?: string; // "A1B2C3"
    }
  | {
      step: 'cd_alert';
      cdAmount: Cents;
      maturesOn: Day;
      best: { title: string; detail: string }; // "Pay off your card, save the rest" / "$2,214 to the card, ..."
      other: OptionRow; // "Renew the CD" / "Earns about $205 a year"
      approvalId?: string;
    }
  | { step: 'what_if' }; // details in state.whatIf

export type PanelStep = PanelView['step'];

/** One offer row in the Call step: "Fri, Nov 13 · $20 fee · Works". */
export interface OfferRow {
  offerId: string;
  newDay: Day;
  fee: Cents;
  label: string; // "Fri, Nov 13 · $20 fee"
  verdict: OfferVerdict;
  pass: boolean;
}

export interface CallView {
  call: Call | null; // null in demo mode before the first line
  negotiation: Negotiation | null;
  /** True after the call dropped: header "Negotiating by text" and the lender console. */
  textMode: boolean;
  elapsedSec: number;
  /** The last 4 transcript lines (UI.md). */
  transcriptTail: TranscriptLine[];
  offers: OfferRow[];
  /** Demo mode: true while the scripted call has a line left (the "Next line" control). Live: false. */
  canAdvance: boolean;
  /** Demo mode: the script is done, so the button reads "Ask Yoshua". Live: false. */
  atEnd: boolean;
  /** Demo mode: the lender's next scripted line, to prefill the lender console; null on PacePay's turn. */
  lenderNext: string | null;
}

export interface WhatIfRow {
  key: WhatIfKey;
  label: string; // "Move the car payment to Fri"
  detail: string; // "Fri, Nov 13 with a $20 fee"
  checked: boolean;
  available: boolean; // e.g. the car row is gone after the deal
}

export interface WhatIfView {
  /** "Lowest in the next 14 days": now -> what if. */
  lowestNow: Lowest;
  lowestWhatIf: Lowest;
  daysBelowZeroNow: number;
  daysBelowZeroWhatIf: number;
  /** Extra lines, only when relevant (card use, emergency fund, or the empty-state hint). */
  extraLines: string[];
  rows: WhatIfRow[];
}

export interface CaseView {
  case: Case;
  /** Activity tab: label each step's "who" with stepActor() from @pacepay/shared (Yoshua for his decisions). */
  plan: Plan | null;
  approvals: Approval[];
  /** The bill being worked (merchant, amount, due day); null for CD and shortfall cases. */
  bill: Bill | null;
}

// ---------------------------------------------------------------------------
// The whole state
// ---------------------------------------------------------------------------

export interface DashboardState {
  mode: DataMode;
  connection: Connection;
  /** The demo clock. */
  day: Day;
  ui: UiState;
  household: HouseholdSummary;
  rules: Rules;
  /** The current plan's checking forecast, 60 days from today, accepted changes applied. */
  forecast: Forecast;
  /**
   * Every change that forecast applies (SnapshotResponse.acceptedChanges; live mode refreshes it
   * from the case's baseChanges and acceptedChanges). Accounts' "Next 14 days" tints a moved
   * payment (a move_item here) green; the what-if engine run starts from these.
   */
  acceptedChanges: Change[];
  scores: HealthScore[];
  chart: ChartView;
  panel: PanelView;
  current: CaseView | null;
  call: CallView | null;
  whatIf: WhatIfView | null;
  /** The iMessage thread mirror, oldest first. */
  thread: Message[];
  /** The activity log, oldest first (the tab shows newest first). */
  activity: ActivityEvent[];
  arena: ArenaResults | null;
  arenaProgress: ArenaProgress | null;
  /** A non-blocking note for the header, e.g. "Server unreachable, showing demo data". */
  notice: string | null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface Actions {
  // Navigation and view
  setTab(tab: Tab): void;
  setRange(range: ChartRange): void;
  togglePresenter(): void;
  toggleStat(key: StatKey): void;

  // The PacePay panel
  /** Heads up: "Ask my lender" or an "Other options" row. Live: answers the option_choice approval. */
  pickOption(optionId: OptionId): void;
  /** Limits: "Call now". Live: answers the call_limits approval with "ok". */
  approveLimits(): void;
  /** Demo: start the scripted call. Live: no-op (the server dials after approveLimits). */
  startCall(): void;
  /** Demo: reveal the next scripted transcript line. Live: no-op. */
  nextLine(): void;
  /** Call: "End call" / "Stop". Demo: back to Heads up. Live: the server owns hang-up, so only a notice. */
  endCall(): void;
  /** "Call dropped? Switch to text". Live: POST /api/demo/fail-call. */
  failCall(): void;
  /** The lender console ("Lender types here"). Live: POST /api/negotiations/:id/lender. */
  lenderSays(text: string): void;
  /** Approve: "Approve". Live: answers the deal approval with "yes". */
  approveDeal(): void;
  /** Limits "Cancel" or Approve "Decline". Live: answers the pending approval with "no". */
  decline(): void;
  /** Done: "What happened" opens the Activity tab. */
  openActivity(): void;
  /** CD alert: "Compare in what-if" (opens what-if with the CD row checked). */
  compareCdInWhatIf(): void;
  /** CD alert: "Later". */
  dismissCdAlert(): void;

  // What-if (the engine runs in the browser)
  toggleWhatIf(): void;
  setWhatIf(key: WhatIfKey, on: boolean): void;

  // Demo controls (header)
  /** "Skip to Wed, Nov 18" (day 11) and "Back to Sat, Nov 7" (day 0). */
  skipClock(): void;
  reset(): void;
  /** Inject the brake_quote bill photo (POST /api/demo/bill-photo). */
  injectBillPhoto(): void;

  // Messages, Accounts, Arena
  /** Coach chat: treated exactly like a text from Yoshua (POST /api/thread). */
  sendMessage(text: string): void;
  /** Your rules (PUT /api/rules). */
  setRules(rules: Rules): void;
  /** The "Pause PacePay" switch. */
  togglePause(): void;
  /** "Run 3 live" (POST /api/arena/run { count: 3, live: true }). */
  runArenaLive(): void;
}

export interface DashboardProps {
  state: DashboardState;
  actions: Actions;
}

export interface UseDashboard {
  state: DashboardState;
  actions: Actions;
  mode: DataMode;
}
