# PacePay build spec

`v2.md` says what PacePay is and why. This doc says exactly how to build it. Read sections 1, 2 and 10 before writing code. After that, live in your own section.

**Five rules that hold everywhere:**

1. **Code does all the math.** No model ever calculates a number. Models read numbers in (from a photo or a call), and the engine checks everything.
2. **`v2.md` is the source of truth for the demo household and every number in it.** This doc never repeats those numbers; tests read them from the fixture, and the fixture comes from `v2.md`.
3. **The contracts in `packages/shared` are frozen after the first 30 minutes.** Changing a type means telling the other two workstreams first.
4. **Every agent step emits an activity event.** If it isn't in the activity feed, judges can't see it.
5. **Nothing is final without Yoshua's yes, and every offer goes through `check_offer`.** These checks live in code, not in prompts.

---

## 1. Repo layout and running locally

A pnpm workspaces monorepo. Everything is TypeScript.

```
/
├─ package.json            # root scripts: dev, test, typecheck, demo:e2e, arena
├─ pnpm-workspace.yaml     # packages/*, apps/*
├─ tsconfig.base.json
├─ .env                    # dotenvx-encrypted, committed
├─ .env.example            # names only
├─ scripts/check-keys.mjs  # verifies every key works
├─ data/                   # gitignored runtime state: state.json, arena.json
├─ packages/
│  ├─ shared/              # @pacepay/shared: types, zod schemas, event names, tool names
│  └─ engine/              # @pacepay/engine: pure forecast engine; runs in Node and the browser
│     ├─ src/              # forecast.ts scores.ts options.ts offers.ts simulate.ts calendar.ts money.ts
│     ├─ fixtures/household.ts   # the v2.md demo household, typed
│     └─ test/             # vitest
└─ apps/
   ├─ server/              # @pacepay/server: Hono HTTP + SSE, agent, Photon bridge, call dispatch
   │  └─ src/
   │     ├─ index.ts       # boots HTTP, store, messaging, watcher
   │     ├─ api/           # route handlers (section 4)
   │     ├─ store/         # in-memory state + JSON snapshot to data/state.json
   │     ├─ bus.ts         # activity events → SSE
   │     ├─ agent/         # planner.ts orchestrator.ts negotiator.ts machine.ts watcher.ts secondOpinion.ts arena.ts
   │     ├─ tools/         # one file per tool (section 5.6)
   │     ├─ models/        # gateway.ts (OpenAI SDK on the TrueFoundry gateway), nvidia.ts (Ultra, optional)
   │     ├─ messaging/     # port.ts + Photon 2.0 adapter (photon.ts) + chart.ts (section 6)
   │     ├─ voice/         # dispatch.ts (LiveKit API calls)
   │     └─ prompts/       # *.md system prompts (section 8)
   ├─ voice/               # @pacepay/voice: LiveKit Agents worker, GPT realtime voice
   │  └─ src/agent.ts, tools.ts, prompts/voice.md
   └─ dashboard/           # @pacepay/dashboard: Next.js App Router, shadcn/ui, Recharts
```

**Why these choices:**

- **Hono for the server.** It's small, TypeScript-first, and has a built-in SSE helper.
- **In-memory state with a JSON snapshot instead of a database.** One server process owns all state, and the demo resets dozens of times. A database adds migrations and setup with no benefit here. `DATABASE_URL` is kept in the env but unused unless you switch the store to Postgres later.
- **No public URL needed.** Photon messages are fetched from Photon's API (polling, or Socket.IO live events), the voice worker connects out to LiveKit Cloud, and the voice worker reaches the server on localhost. The whole system runs on one laptop.

**Ports:** server `8787`, dashboard `3000`. `SERVER_URL` defaults to `http://localhost:8787` and `DASHBOARD_URL` to `http://localhost:3000`. The dashboard reads the server URL through `next.config` (`env: { NEXT_PUBLIC_SERVER_URL: process.env.SERVER_URL }`), so there's no extra env var.

**Run it.** First-time setup (getting the decryption key, adding or changing secrets) is in [README.md › Setup](README.md#setup). Then:

```bash
pnpm install
npx @dotenvx/dotenvx run --convention=nextjs -- node scripts/check-keys.mjs
pnpm dev          # = npx @dotenvx/dotenvx run --convention=nextjs -- pnpm -r --parallel --stream dev
pnpm test         # = pnpm -r test (vitest)
pnpm typecheck
pnpm demo:e2e     # scripted end-to-end run, no phones (section 11)
pnpm arena -- --count 50 --concurrency 4
```

Each app's own `dev` script: server `tsx watch src/index.ts`, voice `tsx src/agent.ts dev`, dashboard `next dev -p 3000`. Every script that needs secrets runs under `npx @dotenvx/dotenvx run --convention=nextjs -- …`, which also loads a personal, gitignored `.env.local`.

---

## 2. Data model

All types live in `packages/shared/src/types.ts`, with matching zod schemas in `schemas.ts`. Money is **integer cents**. Days are **integers counted from demo day 0** (a Saturday, see `v2.md`); `calendar.ts` turns a day into a date.

```ts
export type Cents = number;          // integer
export type Day = number;            // 0 = demo day 0
export type ISODate = string;        // 'YYYY-MM-DD'

// PNC's six categories, in display order
export type Category = 'checking' | 'savings' | 'cds_iras' | 'loans' | 'credit_cards' | 'mortgage';
export type AccountKind =
  | 'checking' | 'savings' | 'cd' | 'ira'
  | 'auto_loan' | 'personal_loan' | 'credit_card' | 'mortgage';

export interface Account {
  id: string;
  kind: AccountKind;
  category: Category;          // cd + ira → cds_iras; auto_loan + personal_loan → loans
  name: string;
  isLiability: boolean;
  balance: Cents;              // assets: money held; liabilities: amount owed (both positive)
  apr?: number;                // 0.2499
  apy?: number;                // CDs
  limit?: Cents;               // credit cards
  minPayment?: Cents;          // monthly minimum or installment
  maturesOn?: Day;             // CDs
  offLimits?: boolean;         // the IRA by default
  reference?: string;          // e.g. 'ending 4417', the only account detail said on calls
  assetValue?: Cents;          // home value on the mortgage account
}

export type ItemKind =
  | 'paycheck' | 'bill' | 'loan_payment' | 'card_autopay' | 'transfer' | 'fee' | 'one_time'
  | 'card_spend';              // everyday spending charged to the card (see v2.md)

export interface ScheduledItem {
  id: string;
  accountId: string;           // the account it posts to (bills post to checking, card_spend to the card)
  label: string;
  amount: Cents;               // signed change to that account's `balance` (on a liability, + means more owed)
  counterAccountId?: string;   // set when money moves between Yoshua's own accounts
  counterAmount?: Cents;       // signed change to the counter account's `balance` (card autopay: checking −, card −)
  day: Day;                    // first occurrence
  every?: { days: number } | { months: number };
  kind: ItemKind;
  counterpartyId?: string;     // e.g. the auto lender
  movable?: boolean;           // can a negotiation move it
}

export interface Rules {
  checkingFloor: Cents;
  savingsFloor: Cents;
  feeLimit: Cents;
  offLimitsAccountIds: string[];
  quietHours?: { start: string; end: string };   // 'HH:MM'
}

export interface Counterparty {
  id: string;
  name: string;                // fictional
  kind: 'auto_lender' | 'card_issuer' | 'mortgage_servicer' | 'utility' | 'other';
  phoneEnv: 'LENDER_PHONE';    // the demo always dials the team's lender phone
  termsDocIds: string[];       // for get_terms
}

export interface Household {
  id: string;
  person: { name: 'Yoshua'; phoneEnv: 'CUSTOMER_PHONE' };
  day0Date: ISODate;           // a Saturday
  grossAnnualIncome: Cents;
  monthlyEssentials: { label: string; amount: Cents }[];
  accounts: Account[];
  scheduled: ScheduledItem[];
  rules: Rules;
  counterparties: Counterparty[];
}

export interface ForecastDay {
  day: Day;
  date: ISODate;
  weekday: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';
  open: Cents;
  close: Cents;
  intradayLow: Cents;          // debits post before credits on the same day
  items: { itemId: string; label: string; amount: Cents }[];
  belowFloor: boolean;         // intradayLow < checkingFloor
  negative: boolean;           // intradayLow < 0
}

export interface Forecast {
  accountId: string;
  days: ForecastDay[];
  lowest: { amount: Cents; day: Day; causeItemIds: string[] };   // causes = debits on or before the lowest day, since the last credit
}

export type ScoreKey = 'cash_cushion' | 'emergency_fund' | 'credit_use' | 'debt_to_income';
export type Color = 'green' | 'yellow' | 'red';
export interface HealthScore {
  key: ScoreKey;
  value: number;               // cents for cash_cushion, months, or a ratio
  display: string;             // '$100', '0.6 months', '56%', '35.5%'
  color: Color;
  reason: string;              // one line, generated by the engine from templates
  improve: string;             // one line
}

export type Change =
  | { type: 'add_item'; item: ScheduledItem }
  | { type: 'move_item'; itemId: string; toDay: Day }
  | { type: 'add_fee'; day: Day; amount: Cents; label: string }
  | { type: 'transfer'; fromAccountId: string; toAccountId: string; amount: Cents; day: Day }
  | { type: 'charge_card'; accountId: string; amount: Cents; day: Day; label: string }
  | { type: 'delay_item'; itemId: string; days: number }
  | { type: 'pay_down'; fromAccountId: string; toAccountId: string; amount: Cents; day: Day };

export type OptionId = 'card' | 'savings' | 'move_payment' | 'cd_renew' | 'cd_payoff_card';
export interface Option {
  id: OptionId;
  label: string;
  changes: Change[];
  lowest: { amount: Cents; day: Day };
  tradeoffs: {                 // every number the text may quote; null when not relevant
    monthlyInterest: Cents | null;
    creditUseBefore: number | null; creditUseAfter: number | null;
    savingsAfter: Cents | null;
    emergencyMonthsBefore: number | null; emergencyMonthsAfter: number | null;
    yearlyInterestSaved: Cents | null; yearlyInterestEarned: Cents | null;
  };
  violations: RuleViolation[]; // e.g. savings below floor
}
export type RuleViolation = 'BELOW_CHECKING_FLOOR' | 'BELOW_SAVINGS_FLOOR' | 'USES_OFF_LIMITS_ACCOUNT' | 'FEE_OVER_LIMIT';

export interface Offer {
  id: string;
  negotiationId: string;
  itemId: string;              // the scheduled item being moved
  newDay: Day;
  fee: Cents;
  heard: string;               // the lender's exact words
  readBackConfirmed: boolean;  // set only after the lender confirms the read-back
}

export type OfferReason =
  | 'OK'
  | 'NEGATIVE_BALANCE'         // intraday low < 0 somewhere in the next 30 days
  | 'BELOW_FLOOR'              // intraday low < checking floor
  | 'PAYDAY_SAME_DAY'          // new day is a payday: risky by rule
  | 'FEE_OVER_LIMIT'           // affordable, but fee > feeLimit
  | 'WEEKEND_ROLLS_FORWARD'    // informational: a weekend day posts on the next business day
  | 'UNKNOWN_ITEM';

export interface OfferCheck {
  offerId: string;
  pass: boolean;               // affordable && withinLimits && !PAYDAY_SAME_DAY
  affordable: boolean;
  withinLimits: boolean;
  postsOnDay: Day;             // after weekend roll-forward
  lowest: { amount: Cents; day: Day };
  reasons: OfferReason[];
}

export type ApprovalKind = 'option_choice' | 'deal' | 'bill_confirm';
export interface Approval {
  id: string;
  kind: ApprovalKind;
  prompt: string;              // the exact text sent to Yoshua
  choices: string[];           // ['1','2','3'] or ['yes','no']
  status: 'pending' | 'approved' | 'declined' | 'answered' | 'timeout';
  answer?: string;
  callId?: string;
  requestedAt: string;         // ISO timestamp
  resolvedAt?: string;
  timeoutMs?: number;          // 60_000 for mid-call deals
}

export interface TranscriptLine { at: string; speaker: 'pacepay' | 'counterparty' | 'customer'; text: string }

export interface Call {
  id: string;
  direction: 'outbound' | 'inbound';
  counterpartyId?: string;
  phone: string;               // E.164
  room: string;                // LiveKit room, 'photon-<id>' (matches the dispatch rule's prefix)
  status: 'dispatching' | 'ringing' | 'active' | 'holding_for_approval' | 'ended' | 'failed';
  negotiationId?: string;
  pinVerified?: boolean;       // inbound only
  transcript: TranscriptLine[];
  outcome?: 'deal' | 'no_deal' | 'handoff_verification' | 'approval_timeout' | 'failed' | 'qa';
  referenceNumber?: string;
  summary?: string;
  startedAt: string;
  endedAt?: string;
}

export interface Negotiation {
  id: string;
  caseId: string;
  counterpartyId: string;
  itemId: string;
  channel: 'voice' | 'text';   // text = the lender console fallback and the arena
  callPlan: CallPlan;
  offers: Offer[];
  pendingOfferId?: string;     // heard, read back, waiting for the lender's confirmation
  state: 'opening' | 'listening' | 'reading_back' | 'countering' | 'awaiting_approval' | 'closed';
  outcome?: Call['outcome'];
}

export interface CallPlan {
  goal: string;                // 'Move the auto payment from day 3 to a day after payday'
  targetDay: Day;              // first acceptable day, chosen by the engine
  acceptableDays: Day[];       // every day check_offer passes with fee 0
  feeLimit: Cents;             // never said out loud
  openingAsk: string;          // e.g. ask to move with no fee
  walkAway: string;            // when to stop
  fallbackText: string;        // what to text Yoshua on no deal
}

export type StepKind =
  | 'read_bill' | 'forecast' | 'build_options' | 'send_options' | 'await_choice'
  | 'get_terms' | 'plan_call' | 'second_opinion' | 'place_call' | 'negotiate'
  | 'confirm_deal' | 'post_call_summary' | 'update_forecast' | 'schedule_followup'
  | 'send_message' | 'answer_question' | 'cd_options';

export type ModelRole =
  | 'nemotron-ultra' | 'nemotron-super' | 'nemotron-nano' | 'nemotron-vision'
  | 'claude-opus' | 'gpt-realtime' | 'engine' | 'code';

export interface PlanStep {
  id: string;
  kind: StepKind;
  title: string;               // shown in the activity feed checklist
  model: ModelRole;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'blocked';
  note?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface Plan {
  id: string;
  caseId: string;
  eventId: string;
  goal: string;
  author: 'nemotron-ultra' | 'template';   // template = fallback when Ultra fails validation twice
  steps: PlanStep[];
}

export interface Case {        // one problem being worked, e.g. "the $650 repair"
  id: string;
  title: string;
  state: CaseState;            // section 5.3
  planId?: string;
  billId?: string;
  chosenOption?: OptionId;
  negotiationId?: string;
  approvalIds: string[];
}

export interface Message {
  id: string;
  direction: 'in' | 'out';
  channel: 'imessage' | 'dashboard';
  text?: string;
  imageUrl?: string;           // served from /api/media/:id
  at: string;
}

export type ActivityType =
  | 'event.received' | 'plan.created' | 'step.started' | 'step.completed' | 'step.skipped' | 'step.failed'
  | 'tool.called' | 'tool.result' | 'model.called'
  | 'message.in' | 'message.out' | 'approval.requested' | 'approval.resolved'
  | 'call.dispatched' | 'call.answered' | 'call.transcript' | 'call.ended' | 'call.failed'
  | 'offer.heard' | 'offer.read_back' | 'offer.confirmed' | 'offer.checked'
  | 'review.result' | 'forecast.updated' | 'scores.updated'
  | 'arena.progress' | 'arena.completed' | 'demo.reset' | 'clock.changed';

export interface ActivityEvent {
  id: string;
  seq: number;                 // monotonically increasing; the dashboard reorders by it
  at: string;
  type: ActivityType;
  caseId?: string;
  planId?: string;
  stepId?: string;
  model?: ModelRole;           // label shown on every feed row
  tool?: ToolName;
  title: string;               // one plain line: 'Nemotron Nano checked "Friday, $20 fee": pass'
  detail?: unknown;            // raw inputs/outputs, collapsed in the UI
  level?: 'info' | 'warn' | 'error';
  ms?: number;                 // duration for model and tool calls
}
```

---

## 3. Engine (`@pacepay/engine`)

Pure functions. No I/O, no `Date.now()`, no randomness. The same input always gives the same output. It runs in the server and in the browser (for the instant what-if panel).

The engine projects **every account's balance day by day** from the household's scheduled items. `forecast()` returns one account's days, checking by default. The engine models exactly the scheduled items listed in `v2.md`, including card spending. Card interest feeds only the option trade-offs (interest on a new charge, interest saved by paying the card off); it isn't posted as an item unless `v2.md` lists one.

```ts
export function forecast(h: Household, opts?: { fromDay?: Day; days?: number; changes?: Change[]; accountId?: string }): Forecast;
export function healthScores(h: Household, opts?: { fromDay?: Day; changes?: Change[] }): HealthScore[];
export function netWorth(h: Household): { assets: Cents; liabilities: Cents; netWorth: Cents };
export function buildOptions(h: Household, bill: { amount: Cents; day: Day; label: string }, opts?: { fromDay?: Day }): Option[];
export function cdOptions(h: Household, cdAccountId: string, opts?: { fromDay?: Day }): Option[];
export function checkOffer(h: Household, offer: { itemId: string; newDay: Day; fee: Cents }, ctx: { baseChanges: Change[]; fromDay?: Day }): OfferCheck;
export function planCallTargets(h: Household, itemId: string, ctx: { baseChanges: Change[]; fromDay?: Day }): Pick<CallPlan, 'targetDay' | 'acceptableDays' | 'feeLimit'>;
export function simulate(h: Household, changes: Change[], opts?: { fromDay?: Day }): { forecast: Forecast; scores: HealthScore[]; netWorth: ReturnType<typeof netWorth> };
export function applyChanges(h: Household, changes: Change[]): Household;
export function dayToDate(h: Household, day: Day): ISODate;
export function postingDay(h: Household, day: Day): Day;            // weekend → next business day
export function monthlyInterest(balance: Cents, apr: number): Cents; // rounded to the cent
export const fixtures: { household: Household };                    // the v2.md household
```

**Behavior rules** (each one has a test):

| Rule | Behavior |
|---|---|
| Horizon | Scores and offer checks look 30 days ahead; the chart shows 60. |
| Weekends | Bank transfers (`paycheck`, `bill`, `loan_payment`, `card_autopay`, `transfer`) and offers dated Saturday or Sunday post on the next business day. Offers get `WEEKEND_ROLLS_FORWARD`. Card spending (`card_spend`) posts on its own day, weekends included. |
| Card spending | Modeled exactly as `v2.md` describes it: a weekly `card_spend` item on the card account. It changes the card balance (credit use, the CD payoff amount), never checking. |
| Same-day posting | On any day, debits post before credits. `intradayLow` is the balance after all debits and before any credits. |
| Payday is risky | An offer whose posting day is a payday fails with `PAYDAY_SAME_DAY`, even when the end-of-day balance is fine. |
| Affordability | `affordable` = the intraday low stays at or above `checkingFloor` for 30 days (reasons `BELOW_FLOOR`, plus `NEGATIVE_BALANCE` under $0). |
| Limits | `withinLimits` = fee ≤ `feeLimit`, no off-limits account used, savings ≥ `savingsFloor`. Affordability and limits are reported separately, so "affordable but over your fee limit" is expressible. |
| `pass` | `affordable && withinLimits && !PAYDAY_SAME_DAY`. |
| Causes | `lowest.causeItemIds` = the debits on or before the lowest day since the most recent credit. For the repair case, that's the mortgage and the car payment. |
| Cash cushion | Lowest `intradayLow` in the next 30 days. Green: never below the floor. Yellow: below the floor but not below $0. Red: below $0. |
| Emergency fund | Savings ÷ sum of `monthlyEssentials`. Green 3+ months, yellow 1–3, red under 1. |
| Credit use | Card balances ÷ card limits. Green under 30%, yellow 30–50%, red over 50%. |
| Debt-to-income | Monthly debt payments (including the card minimum) ÷ gross monthly income. Green under 36%, yellow 36–43%, red over 43%. |
| Options for a bill | `card` (charge it; monthly interest, credit use before/after), `savings` (transfer the shortfall plus floor; savings after; emergency months before/after; violations), `move_payment` (move the soonest movable debit that causes the low to `planCallTargets().targetDay`). |
| CD options | `cd_renew` (interest earned in a year) and `cd_payoff_card` (pay off the card's **projected balance on the CD's maturity day**, put the rest in savings; interest saved in a year, emergency months after, credit use after = the card's projected balance after the payoff ÷ limit). |
| Rounding | Interest rounds to the cent. Displays round months to one decimal and percentages to whole numbers, except debt-to-income (one decimal). |

**Unit tests** (`packages/engine/test`). Expected values come from `v2.md`. Each test names the `v2.md` line it encodes, so a fix to `v2.md` maps to one test.

| Test | Encodes `v2.md` |
|---|---|
| `fixture.summary` | "Demo household": the essentials total, net worth, and every account row |
| `forecast.beforeQuote` | "Checking this week", row "Before the quote" |
| `forecast.payFromChecking` | Row "Pay $650 from checking, no fix", including lowest day and causes (mortgage + car payment) |
| `offer.wednesdayFails` | Row "Car payment moved to Wednesday" → `pass:false`, `BELOW_FLOOR` + `NEGATIVE_BALANCE` |
| `offer.fridayFee20Passes` | Row "Car payment moved to Friday, $20 fee" → `pass:true` |
| `offer.thursdayPaydayRisky` | Bullet "Thursday also fails" → `PAYDAY_SAME_DAY`, intraday low as stated |
| `offer.fee35AffordableNotAllowed` | Bullet "A $35 fee is affordable but not allowed" → `affordable:true`, `withinLimits:false`, `FEE_OVER_LIMIT` |
| `offer.weekendRollsForward` | Rule: a Saturday offer posts Monday |
| `options.card` | Bullet "The card option" (monthly interest, credit use before/after) |
| `options.savings` | Bullet "The savings option" (savings after, floor violation, emergency months) |
| `options.movePayment` | Story step 2, option 3: target day is the Friday after payday |
| `scores.day0` | "Health scores on day 0" (all four, values and colors) |
| `scores.afterCall` | Same paragraph: cash cushion green after the deal |
| `cd.options` | Story step 7 and "After the CD move" (renew interest, payoff amount on the maturity day, interest saved, emergency months, credit use) |
| `card.weeklySpend` | `v2.md`'s card-spending model: the card balance rises on each scheduled spending day and checking is unchanged |
| `engine.pure` | Same inputs twice → deep-equal outputs; no globals read |

---

## 4. Server contracts (`@pacepay/server`)

Base URL `SERVER_URL`. JSON in and out. Errors: `{ error: { code: string, message: string } }` with a 4xx or 5xx status.

Endpoints under `/api/voice/*` accept requests from localhost only. The voice worker runs on the same machine as the server.

### Dashboard reads and writes

| Method and path | Request | Response |
|---|---|---|
| `GET /api/household` | — | `{ household: Household, netWorth, byCategory: Record<Category, Account[]> }` |
| `GET /api/forecast?days=60` | — | `Forecast` for checking, with every accepted change applied |
| `GET /api/scores` | — | `HealthScore[]` |
| `POST /api/simulate` | `{ changes: Change[] }` | `{ forecast, scores, netWorth }` (the dashboard may also run the engine locally) |
| `GET /api/rules` / `PUT /api/rules` | `Rules` | `Rules` |
| `GET /api/thread` | — | `Message[]` (the iMessage thread mirror) |
| `POST /api/thread` | `{ text: string }` | `{ ok: true }` (coach chat: treated exactly like a text from Yoshua) |
| `GET /api/cases/current` | — | `{ case: Case, plan: Plan, approvals: Approval[] }` or `{ case: null }` |
| `GET /api/calls/:id` | — | `Call` |
| `GET /api/media/:id` | — | image bytes (bill photos and chart PNGs) |
| `GET /api/arena` | — | `ArenaResults` (section 11) |
| `POST /api/arena/run` | `{ count: number, concurrency?: number, live?: boolean }` | `{ runId }` (progress over SSE) |

### Demo controls

| Method and path | Request | Response |
|---|---|---|
| `POST /api/demo/reset` | — | `{ ok: true }` — reload the fixture, clear cases, thread, calls and approvals, set the clock to day 0, emit `demo.reset` |
| `POST /api/demo/clock` | `{ day: Day }` or `{ advance: number }` | `{ day }` — emit `clock.changed`, then run the watcher's daily check (this is how the CD alert fires) |
| `POST /api/demo/bill-photo` | `{ fixture: 'brake_quote' }` or multipart image | `{ ok: true }` — inject a bill photo as if Yoshua texted it (rehearsal without phones) |
| `POST /api/demo/customer-says` | `{ text }` | `{ ok: true }` — inject a text from Yoshua |

### Lender console (text negotiation; the call's fallback)

| Method and path | Request | Response |
|---|---|---|
| `POST /api/negotiations/:id/lender` | `{ text: string }` | `{ reply: string, state: Negotiation['state'], awaitingApproval: boolean }` |
| `GET /api/negotiations/:id` | — | `Negotiation` |

### Voice worker endpoints

These are the server side of the voice tools in section 7. The voice model only ever sees what these return.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/voice/calls/:id/brief` | — | `{ direction, greeting: string, goal: string, personName: 'Yoshua', accountReference: string, counterpartyName?: string }`, with no balances or limits |
| `POST /api/voice/calls/:id/decide` | `{ utterance: string }` | `DecideResult` |
| `POST /api/voice/calls/:id/approval` | — | `{ status: 'pending' \| 'approved' \| 'declined' \| 'timeout', say?: string, next?: 'listen' \| 'end_call' }` (the worker polls this) |
| `POST /api/voice/calls/:id/events` | `{ type: 'answered' \| 'transcript' \| 'ended' \| 'failed', speaker?, text?, sipStatus?: string }` | `204` |
| `POST /api/voice/inbound` | `{ room: string, callerPhone: string }` | `{ callId, greeting: string, requirePin: boolean }` |
| `POST /api/voice/calls/:id/verify-pin` | `{ digits: string }` | `{ ok: boolean, say: string }` |
| `POST /api/voice/calls/:id/ask` | `{ question: string }` | `{ say: string }` (inbound Q&A; numbers allowed only after the PIN) |

```ts
export interface DecideResult {
  say: string;                                   // the exact words to speak
  next: 'listen' | 'await_approval' | 'end_call';
  state: Negotiation['state'];
}
```

### Server-sent events

`GET /api/events` returns `text/event-stream`. Every message has `id: <seq>` so the browser can resume with `Last-Event-ID`.

| `event:` | `data:` |
|---|---|
| `activity` | `ActivityEvent` |
| `thread` | `Message` |
| `forecast` | `Forecast` (after any accepted change) |
| `scores` | `HealthScore[]` |
| `case` | `{ case: Case, plan: Plan }` |
| `call` | `Call` (on status change and each transcript line) |
| `approval` | `Approval` |
| `clock` | `{ day: Day }` |
| `arena` | `{ runId, done: number, total: number, latest?: ArenaRun }` |

---

## 5. Agent

### 5.1 Events

| Event | Source | Starts |
|---|---|---|
| `BILL_PHOTO` | An image from Yoshua, or `/api/demo/bill-photo` | A new case and a plan |
| `CHOICE_REPLY` | "1", "2" or "3" from Yoshua while an `option_choice` approval is pending | Resumes the case |
| `APPROVAL_REPLY` | "yes" or "no" from Yoshua while a `deal` or `bill_confirm` approval is pending | Resumes the case |
| `TEXT` | Any other text from Yoshua (iMessage or coach chat) | `answer_question` with Super and tools |
| `DAILY_CHECK` | The watcher on each clock change, and once per real day | Forecast check; raises `CD_MATURING` or `SHORTFALL` when found |
| `CD_MATURING` | Daily check: a CD matures within 2 business days | A new case and a short plan (no call) |
| `SHORTFALL` | Daily check: cushion goes red with no open case | A new case (same shape as `BILL_PHOTO` without the bill) |
| `CALL_FAILED` | The voice worker or dispatch | Moves the negotiation to the text channel and tells the dashboard to open the lender console |
| `INBOUND_CALL` | The voice worker | A call record; PIN gate |

Reply parsing is code, not a model: trim, lowercase, and strip punctuation. `^[123]$` matches a choice. `^(y|yes|yep|ok|approve|approved)$` is yes and `^(n|no|nope|decline)$` is no. Anything else becomes `TEXT`.

### 5.2 Plans

For every case-starting event, **Nemotron 3 Ultra writes the plan** as JSON matching `Plan`, using only the `StepKind` vocabulary. Code then validates the plan:

1. **Every step kind is known**, and every step's `model` matches the table in 5.4.
2. **Ordering gates hold:**
   - `place_call` comes after `await_choice`.
   - `second_opinion` comes before `place_call`.
   - `confirm_deal` comes after `negotiate`.
   - `post_call_summary` comes after `place_call`.
3. **No call when it isn't needed:** a `CD_MATURING` plan has no `place_call`.

If validation fails, Ultra gets the errors and one retry. If that fails too, use the event's template plan (`author: 'template'`) and log a `warn` activity event. The feed shows the plan as a checklist either way.

Example: Ultra's plan for the repair (`BILL_PHOTO`).

```json
{
  "goal": "Cover the $650 repair without going below Yoshua's floor",
  "steps": [
    { "kind": "read_bill",         "title": "Read the repair quote",              "model": "nemotron-vision" },
    { "kind": "forecast",          "title": "Check the week if paid today",        "model": "engine" },
    { "kind": "build_options",     "title": "Compare card, savings, moving a payment", "model": "engine" },
    { "kind": "send_options",      "title": "Text Yoshua the options and a chart", "model": "nemotron-super" },
    { "kind": "await_choice",      "title": "Wait for Yoshua's pick",              "model": "code" },
    { "kind": "get_terms",         "title": "Pull the auto loan's terms",          "model": "nemotron-super" },
    { "kind": "plan_call",         "title": "Plan the call to the lender",         "model": "nemotron-ultra" },
    { "kind": "second_opinion",    "title": "Second opinion on the call plan",     "model": "claude-opus" },
    { "kind": "place_call",        "title": "Call the lender",                     "model": "code" },
    { "kind": "negotiate",         "title": "Negotiate the due date",              "model": "nemotron-nano" },
    { "kind": "confirm_deal",      "title": "Confirm the deal Yoshua approved",    "model": "code" },
    { "kind": "post_call_summary", "title": "Text Yoshua the summary",             "model": "nemotron-super" },
    { "kind": "update_forecast",   "title": "Update the forecast",                 "model": "engine" },
    { "kind": "schedule_followup", "title": "Remind Yoshua the night before",      "model": "code" }
  ]
}
```

When Yoshua picks option 1 or 2, the orchestrator marks the call steps `skipped` and adds one `send_message` step that explains how to do it. PacePay never moves money.

### 5.3 State machine (`agent/machine.ts`)

One case at a time. The states are `CaseState`:

```
NEW → ANALYZING → OPTIONS_SENT → AWAITING_CHOICE
  ├─ choice 1/2 → ADVISED → DONE
  └─ choice 3 → PREPARING_CALL → REVIEWING → CALLING → NEGOTIATING ⇄ AWAITING_APPROVAL
                                                         ├─ approved → CONFIRMING → SUMMARIZING → DONE
                                                         ├─ declined / no deal → SUMMARIZING → DONE
                                                         ├─ approval timeout → HOLD_REQUESTED → SUMMARIZING → DONE
                                                         └─ call failed → TEXT_NEGOTIATION → (same branches)
CD_MATURING: NEW → ANALYZING → OPTIONS_SENT → AWAITING_CHOICE → ADVISED → DONE
```

**Hard gates in code.** A transition that breaks one throws and is logged as an `error` activity event.

| Gate | Enforced in |
|---|---|
| No `place_call` unless the case's `chosenOption === 'move_payment'` came from Yoshua's reply | `tools/place_call.ts` |
| No `place_call` until `second_opinion` returned `approve`, or `revise` was applied, or it timed out (logged as `warn`) | `machine.ts` |
| Every new offer is read back, and `check_offer` runs only after the lender confirms the read-back | `negotiator.ts` |
| No deal is agreed on the call until `Approval(kind:'deal').status === 'approved'` | `negotiator.ts` |
| The voice model's brief contains no balances, limits or reasons | `api/voice.ts` builds it from an allowlist |
| Inbound calls get numbers only when the caller ID matches `CUSTOMER_PHONE` and `verify-pin` succeeded | `api/voice.ts` |
| PacePay-initiated texts respect `quietHours`, except replies and mid-call approvals | `tools/send_message.ts` |

### 5.4 Models and timeouts

**One gateway for almost every model.** Chat, tools, vision, Claude, embeddings, images and text-to-speech all go through Ram's TrueFoundry gateway: the OpenAI SDK with `baseURL: TRUEFOUNDRY_BASE_URL` and `apiKey: TRUEFOUNDRY_API_KEY`, using chat completions with `tools`. Model IDs are the gateway's `group/model` names. Two things aren't on the gateway: GPT realtime (the voice worker uses `OPENAI_API_KEY` directly) and Nemotron 3 Ultra (optional, through build.nvidia.com with `NVIDIA_API_KEY`). Without an NVIDIA key, the planner uses Super.

Model IDs (they live in `.env`; the gateway ones were tested on Nov 7):

| Env var | Model ID |
|---|---|
| `NEMOTRON_ULTRA_MODEL` | `nvidia/nemotron-3-ultra-550b-a55b` (build.nvidia.com only, optional) |
| `NEMOTRON_SUPER_MODEL` | `aws-bedrock/nvidia.nemotron-super-3-120b` (correct tool call in 0.8 s) |
| `NEMOTRON_NANO_MODEL` | `aws-bedrock/nvidia.nemotron-nano-3-30b` (skipped the tool in a quick test; calls use Super until Nano passes with the real prompt) |
| `NEMOTRON_VISION_MODEL` | `aws-bedrock/nvidia.nemotron-nano-12b-v2` (Nemotron Nano 2 VL; read a phone number off an image correctly in 0.9 s) |
| `ANTHROPIC_MODEL` | `claude-group/claude-opus-5-5` (tool calls and image reading work through the gateway) |
| `EMBED_MODEL` | `openai-group/text-embedding-3-small` |
| `IMAGE_MODEL` | `openai-group/gpt-image-2` |
| `TTS_MODEL` | `elevenlabs-primary/eleven_v3` (Devpost voiceover) |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2`, falling back to `gpt-realtime` (OpenAI directly) |

Claude calls use the same gateway client. Don't send `temperature`, `top_p` or `top_k`, don't force `tool_choice`, and when you need JSON, ask for it and validate it with zod, retrying once on a parse failure.

| Step or job | Model | Timeout | On timeout or error |
|---|---|---|---|
| Write the plan | Nemotron 3 Ultra if `NVIDIA_API_KEY` is set, otherwise Super | 45 s | Retry once with Super, then use the template plan |
| `plan_call`, ranking options, CD advice | Ultra, or Super | 45 s | Super |
| Orchestrator (run steps, write texts, answer questions) | Nemotron 3 Super (`NEMOTRON_SUPER_MODEL`) | 20 s | Retry once, then a canned text |
| `decide` on a call | Nemotron 3 Super (Nano once it handles tools reliably) | 4 s | Say "One moment," retry once, then say "Let me check on that and call you back," and end with `no_deal` |
| `read_bill` | Nemotron vision (`NEMOTRON_VISION_MODEL`) | 20 s | Ask Yoshua to type the amount and due date |
| Bill cross-check (Should) | Claude (`ANTHROPIC_MODEL`) | 20 s | Skip, log `warn` |
| `second_opinion` (Should) | Claude | 30 s | Proceed, log `warn` |
| `get_terms` (Should) | `EMBED_MODEL` | 10 s | Proceed without terms |
| Arena lenders | Ultra, or Super | 30 s per turn | Mark the run `errored`; don't count it |
| Arena grading | Claude | 60 s | Mark `ungraded` |
| Mid-call approval | Yoshua | **60 s** | Ask the lender to hold the offer, get a reference number, end the call, text Yoshua |
| Option choice | Yoshua | none | A reminder text after 30 minutes of demo-clock time |

### 5.5 Text the agent sends

Super writes every Yoshua-facing text from a **facts object** the engine produced. The prompt forbids any number not in the facts object, and code checks it: every `$` amount and `%` in the outgoing text must appear in the facts object, or the text is regenerated once and then sent from a template.

### 5.6 The 14 tools

Schemas live in `packages/shared/src/tools.ts` as zod objects. The same definitions become the JSON schemas sent to Nemotron. Every call emits `tool.called` and `tool.result`.

| Tool | Called by | Input | Output | Side effects |
|---|---|---|---|---|
| `get_accounts` | Orchestrator, Q&A | `{}` | `{ byCategory: Record<Category, Account[]>, netWorth }` | — |
| `get_forecast` | Orchestrator, Q&A | `{ days?: number }` | `{ lowest, days: ForecastDay[] (compact), scores: HealthScore[] }` | — |
| `simulate` | Orchestrator, Q&A | `{ changes: Change[] }` | `{ lowest, scores, netWorth }` | — |
| `check_offer` | Negotiator (via code) | `{ itemId, newDay, fee }` | `OfferCheck` | emits `offer.checked` |
| `get_terms` | Orchestrator | `{ counterpartyId, question: string }` | `{ passages: { docId, text, score }[] }` | — |
| `read_bill` | Orchestrator | `{ mediaId }` | `{ merchant, amount: Cents, dueDay: Day \| null, description, confidence: number, crossCheck?: { agrees: boolean, amount?: Cents, dueDay?: Day } }` | stores the bill on the case |
| `second_opinion` | Orchestrator | `{ callPlan: CallPlan, rules: Rules, script: string }` | `{ verdict: 'approve' \| 'revise', issues: { severity: 'high' \| 'low', issue: string, fix: string }[] }` | emits `review.result` |
| `send_message` | Orchestrator | `{ text: string, facts: Record<string, string> }` | `{ messageId }` | sends to Yoshua's iMessage thread and mirrors it to the dashboard |
| `send_chart` | Orchestrator | `{ kind: 'week' \| 'what_if', changes?: Change[] }` | `{ messageId, mediaId }` | renders a PNG and sends it as an image |
| `request_approval` | Orchestrator, negotiator | `{ kind: ApprovalKind, prompt: string, choices: string[], timeoutMs?: number, callId?: string }` | `{ approvalId }` | sends the prompt; the reply resolves it |
| `place_call` | Orchestrator | `{ negotiationId }` | `{ callId, room }` | dispatches the voice agent and dials `LENDER_PHONE` |
| `decide` | Voice worker, lender console, arena | `{ negotiationId, utterance: string }` | `DecideResult` | updates the negotiation; may call `check_offer` and `request_approval` |
| `post_call_summary` | Orchestrator | `{ callId }` | `{ messageId, summary, referenceNumber? }` | texts Yoshua |
| `schedule_followup` | Orchestrator | `{ atDay: Day, text: string }` | `{ followupId }` | the watcher sends it when the clock passes `atDay` |

**How `decide` works** (`agent/negotiator.ts`). It's a ReAct loop around Nano with code-enforced steps:

1. Append the utterance to the transcript.
2. Nano classifies it and extracts any offer: `{ kind: 'offer' | 'confirm' | 'deny' | 'question' | 'verification_request' | 'refusal' | 'chitchat', offer?: { day: string, fee?: number } }`. Code converts the day phrase to a `Day` using the demo calendar.
3. **New offer:** store it as pending, set state `reading_back`, and return the read-back ("So that's Friday, with a twenty-dollar fee?").
4. **Confirmation of a pending offer:** run `check_offer`.
   - **Pass:** `request_approval(kind:'deal', timeoutMs: 60000)` and return `{ say: 'Let me confirm with Yoshua, one moment.', next: 'await_approval' }`.
   - **Fail:** Nano picks a counter from the `CallPlan`:
     - Ask for a waiver first when the only problem is the fee.
     - Otherwise ask for `targetDay`.
     - Never state the reason or Yoshua's limits.
5. **Verification request:** ask for a reference number, set the outcome to `handoff_verification`, and end the call.
6. **Refusal:** thank them, set the outcome to `no_deal`, and end the call.
7. **Question or chitchat:** Nano answers briefly within the brief's allowlist.

---

## 6. Messaging (Photon bridge)

`apps/server/src/messaging/port.ts` defines one interface. The rest of the server only uses this.

```ts
export interface MessagingPort {
  start(onInbound: (m: InboundMessage) => Promise<void>): Promise<void>;
  sendText(text: string): Promise<{ id: string }>;
  sendImage(png: Buffer, name: string): Promise<{ id: string }>;
  fetchImage(ref: string): Promise<Buffer>;     // incoming bill photos
}
export interface InboundMessage { id: string; from: string; text?: string; imageRef?: string; at: string }
```

**The server talks to Photon 2.0 through its REST API, using the official client `@photon-ai/api`** (`pnpm add @photon-ai/api` in `apps/server`; needs Node 22+). Auth is the project API key `PHOTON_API_KEY` (`pho_sk_…`, full access), sent as a bearer token to `https://api.photon.codes/v1`. The project is on the **Photon 2.0 beta dashboard, app.beta.photon.codes**, not the older app.photon.codes. The adapter is `messaging/photon.ts`:

```ts
import { Photon } from "@photon-ai/api";

// Create the client with PHOTON_API_KEY. Check Photon's API-client "Credentials" page for the exact constructor option.
const photon = new Photon({ apiKey: process.env.PHOTON_API_KEY! });
const id = process.env.PHOTON_PROJECT_ID!;

// Receive: poll every 2 seconds and follow nextPageToken. Socket.IO live events are the upgrade.
const page = await photon.projects.listMessages({
  path: { id },
  query: { createdSince, direction: "received", order: "asc", pageSize: 100, platform: "imessage", pageToken },
});
// Accept only Yoshua: normalize the sender to E.164 and compare it with CUSTOMER_PHONE.
// Keep the incoming message's space.id (Yoshua's conversation) and receivedBy.id (PacePay's sender id).

// Send text into Yoshua's conversation.
await photon.projects.sendMessage({
  path: { id },
  headers: { "idempotency-key": `pacepay:${outboundId}` },
  body: { spaceId, senderId, parentMessageId, content: { type: "text", format: "plain", text } },
});
```

**Verified on Nov 7 with raw HTTP** (text and image both reached Yoshua's iPhone as `delivered`):

- **Always send a `User-Agent` header** (for example `pacepay/0.1`). Photon's bot filter rejects Python's default client with a 403 (Cloudflare error 1010).
- **List messages:** `GET /v1/projects/{id}/messages?pageSize=50&order=desc` returns `{ items: [...] }`. Each message has `id`, `content`, `space.id`, `sentBy`, `receivedBy` (PacePay's own user ID on inbound messages), `status` (`received`, `dispatched`, `delivered`) and `timestamps`.
- **Send text:** `POST /v1/projects/{id}/messages` with an `Idempotency-Key` header and `{ spaceId, senderId, content: { type: "text", format: "plain", text } }`. `parentMessageId` is optional. The reply is `202` with status `dispatched`.
- **Send an image:** first upload it with `POST /v1/projects/{id}/attachments` as `multipart/related`. It takes exactly two parts: JSON `{ contentType, sizeBytes, filename }`, then the file bytes. Send `Content-Length` and `Idempotency-Key` too. You get `201` with an `pho_att_…` ID. Then send `content: { type: "attachment", attachmentId }`. **Don't send `metadata`** (Photon owns it and rejects captions); put any caption in a separate text.
- **Incoming photos:** `GET /v1/projects/{id}/attachments/{attachmentId}/content`.
- The API also lists `poll` content. It might suit numbered options, but it's untested on the shared beta line.

**Photon facts that shape the design:**

- **The free plan uses a shared iMessage number** (`PHOTON_IMESSAGE_NUMBER`). On the dashboard's iMessage page, add Yoshua's phone as a sender and assign a number from the shared pool. Only assigned senders reach the line, and group chats aren't supported.
- **PacePay can text first once the person has messaged the line** (verified Nov 7). Photon's rule: a shared line sends only in direct conversations, to someone who has messaged it since they were paired. Yoshua already sent `ping`, so PacePay can start any message, including the CD alert, in that conversation. Its IDs are `PHOTON_CUSTOMER_SPACE_ID` and `PHOTON_AGENT_SENDER_ID` in `.env`.
- **Only assigned senders can text the line.** That's why the lender's text fallback is the dashboard's lender console, not iMessage.
- **Beta iMessage supports text and images only, with no tapbacks.** Approvals are typed replies ("1", "2", "3", "yes", "no").
- **Voice uses a separate SMS number** (`PHOTON_VOICE_NUMBER`, $2/month from the project's credit) with a voice profile (`PHOTON_VOICE_PROFILE_ID`). PacePay never texts from that number.

The bridge ignores messages from anyone but `CUSTOMER_PHONE`. It stores every message in the thread and emits `message.in` / `message.out`. If the receive loop throws, it restarts after 2 seconds and logs a `warn` event.

**Chart images** (`messaging/chart.ts`, owned by Messaging and voice): build an SVG line chart from `Forecast` (7 days, floor line, red dips, bill markers), then render it to PNG with `@resvg/resvg-js`. No AI-generated images.

---

## 7. Voice

> **Photon 2.0 supports calls on the free plan,** through an SMS number ($2/month) and a voice profile, with calls billed at $0.013/minute from the project's $100 credit. PacePay's call number was bought on Nov 7 (`PHOTON_VOICE_NUMBER` in `.env`; $2/month on the team's card once the credit runs out). Calls still need a LiveKit project, the default voice profile pointing at it, and an OpenAI key for the voice. Until the number and voice profile are live, build and test the worker in LiveKit's Agents Playground (browser audio, no phone line needed). Text negotiation through the lender console stays a Must and carries the demo if a call fails.

### 7.1 Call path

```
Outbound:  server place_call
           → LiveKit API: agentDispatch.createDispatch(room, 'pacepay-voice', { metadata: { callId } })
           → voice worker joins room, fetches brief
           → LiveKit API: sip.createSipParticipant(LIVEKIT_SIP_OUTBOUND_TRUNK_ID, LENDER_PHONE, room,
                 { participantIdentity: 'counterparty', waitUntilAnswered: true, playDialtone: true })
           → LiveKit outbound trunk → sip.photon.codes:5061 (TLS) → Photon SMS number → lender phone rings

Inbound:   caller dials the Photon SMS number
           → Photon voice profile (SIP, TLS) → LiveKit inbound trunk
           → dispatch rule (Individual, room prefix 'photon-', agent 'pacepay-voice')
           → voice worker joins, reads the caller's number from the SIP participant attributes
             (`sip.phoneNumber`), calls POST /api/voice/inbound
```

Outbound rooms are named `photon-<callId>`, matching the inbound prefix. The dashboard setup follows Photon's cookbook "Connect Photon to LiveKit with SIP":
- a LiveKit inbound trunk with `authUsername`/`authPassword`
- a dispatch rule with room prefix `photon-`
- an outbound trunk to `sip.photon.codes:5061` over TLS with Photon's outbound credentials (trunk ID `ST_…`)

Calls are placed through LiveKit's SIP participant API (`CreateSIPParticipant`: `sip_trunk_id`, `sip_call_to`, `room_name`, `participant_identity`, `wait_until_answered`). Section 9 lists who does each part.

### 7.2 Worker (`apps/voice/src/agent.ts`)

- `@livekit/agents` 1.x and `@livekit/agents-plugin-openai`.
- Session LLM: `new openai.realtime.RealtimeModel({ model: OPENAI_REALTIME_MODEL, voice: 'marin' })`. Try `gpt-realtime-2` first and fall back to `gpt-realtime`.
- Register the worker with `agentName: 'pacepay-voice'`. Explicit dispatch is required for outbound calls.
- Tools are `llm.tool({ name, description, parameters: z.object(...), execute })` in the agent's `tools` array. Each one calls a server endpoint from section 4.

| Voice tool | Server endpoint | Notes |
|---|---|---|
| `decide(utterance)` | `POST /api/voice/calls/:id/decide` | Called after every counterparty turn that mentions a date, money, a fee, verification, or refusal. Speak `say` word for word. |
| `await_approval()` | Polls `POST /api/voice/calls/:id/approval` every 2 s for up to 60 s | At 20 s and 40 s the worker calls `session.say('Thanks for holding, still checking with Yoshua.')`. When it resolves, speak `say`. |
| `end_call(reason)` | `POST /api/voice/calls/:id/events {type:'ended'}` | Then delete the room through the LiveKit API to hang up. |
| `verify_pin(digits)` | `POST /api/voice/calls/:id/verify-pin` | Inbound only. |
| `ask_pacepay(question)` | `POST /api/voice/calls/:id/ask` | Inbound only, after the PIN. |

The worker also posts every transcript line (both speakers) to `/events`, so the dashboard shows the live transcript.

### 7.3 What the voice model knows

Only the brief: the greeting, the goal, Yoshua's first name, the account reference (e.g. "ending 4417") and the counterparty's name. **It never gets balances, the fee limit, the floors, or why an offer failed.** It learns what to say one line at a time from `decide`. Section 8.4 has its instructions.

### 7.4 Flows

**Opening an outbound call:** the greeting comes from the brief, for example: "Hi, I'm PacePay, an AI assistant calling on behalf of Yoshua, with Yoshua's permission, about the auto loan ending 4417. This call is transcribed."

**Read-back:** for every new offer, `decide` returns a read-back line first. The offer is checked only after the lender confirms it.

**Mid-call approval:**
1. `decide` returns `next: 'await_approval'`.
2. The worker says the line and calls `await_approval()`.
3. Yoshua gets the text with the offer.
4. Yoshua replies "yes" and the server resolves the approval.
5. The worker speaks the confirmation.
6. On timeout, the server's `say` asks the lender to hold the offer and asks for a reference number, then `next: 'end_call'`.

**Inbound calls:**
1. The worker asks for the PIN. Caller ID must equal `CUSTOMER_PHONE` and the spoken digits must equal `INBOUND_PIN`.
2. Three failures end the call.
3. Once verified, `ask_pacepay` answers with numbers. For example, "What did the lender say?" is answered from the last call's summary.
4. Unknown callers get: "I can only discuss account details with the account holder."

**Summary:** when a call ends, the server runs `post_call_summary`. Super writes 2–3 lines from the transcript and outcome, and the text goes to Yoshua's thread with the reference number when there is one.

**Fallback to text:** if `createSipParticipant` throws `SipCallError`, or the call ends before any outcome:
1. The server emits `call.failed` and moves the negotiation to `channel: 'text'`.
2. The dashboard opens the lender console.
3. The judge types to the same negotiator through `POST /api/negotiations/:id/lender`.

---

## 8. Prompts (first drafts)

Store each prompt as a file in `apps/server/src/prompts/` (voice: `apps/voice/src/prompts/`). Variables use `{{double_braces}}`.

### 8.1 Planner (Nemotron 3 Ultra)

```
You are PacePay's planner. PacePay is a money assistant for one person, {{person_name}}.
You receive an EVENT and a SNAPSHOT (accounts, rules, a forecast summary, open cases).
Write a plan as JSON matching the Plan schema. Use only these step kinds: {{step_kinds}}.
Each step needs a short title a judge can read in a feed, and the model that runs it: {{model_table}}.

Rules:
- You never calculate numbers. Steps of kind forecast, build_options, cd_options and check_offer are done by the engine.
- Include get_terms only when the next action depends on a lender's or biller's policy you don't already have.
- A phone call is always: await_choice → plan_call → second_opinion → place_call → negotiate → confirm_deal → post_call_summary.
- Never plan a call for a CD alert or a question. Never plan to move money.
- Prefer the fewest steps that fully handle the event.
Output only the JSON object.
```

### 8.2 Orchestrator and coach (Nemotron 3 Super)

```
You are PacePay, a calm, plain-spoken money assistant texting {{person_name}}.
You are carrying out step "{{step_title}}" of a plan. Use tools to get every fact.

Writing rules:
- Short texts. One idea per line. No jargon, no emojis, no markdown.
- Every dollar amount, percentage, date or count you write must appear in FACTS. If you need another number, call a tool.
- When you offer options, number them 1, 2, 3, give each one trade-off in a few words, and say which you'd pick and why in one clause.
- Never say a guarantee. Never tell Yoshua you moved money. PacePay never moves money.
- If Yoshua asks something you can answer with get_accounts, get_forecast or simulate, answer it. If not, say what you can do.

FACTS: {{facts_json}}
```

### 8.3 Negotiator (Nemotron 3 Nano)

```
You negotiate one payment change for {{person_name}} with {{counterparty_name}}.
Goal: {{call_plan.goal}}. Opening ask: {{call_plan.opening_ask}}.
You receive the transcript so far and the lender's latest words.

Return JSON: {"kind": "offer|confirm|deny|question|verification_request|refusal|chitchat",
              "offer": {"day": "<the day as the lender said it>", "fee": <dollars or null>} | null,
              "say": "<only for question or chitchat: one short sentence>"}

Rules:
- Extract offers exactly as heard. Don't fill in a fee the lender didn't say.
- Never mention balances, paychecks, limits, other bills, or why something doesn't work.
- Be polite and brief. One sentence per turn.
```

Counter lines are chosen by code from the call plan (ask for a waiver first, then the target day). Nano only classifies, extracts, and answers small talk. That keeps it fast and keeps it from inventing terms.

### 8.4 Voice (GPT realtime)

```
You are the voice of PacePay, an AI assistant calling {{counterparty_name}} on behalf of {{person_name}}.
Open with exactly: "{{greeting}}"
You do not make decisions and you do not know any account balances.
After the other person says anything about a date, an amount, a fee, verifying identity, or saying no,
call decide with their exact words, then say the returned "say" text exactly, word for word.
While waiting for a tool, you may say one short filler like "One second, let me check that."
If decide returns next=await_approval, say the line, then call await_approval.
If a tool returns next=end_call, say the line, thank them, and call end_call.
Speak naturally, warmly, and briefly. Let them interrupt you. Never invent terms, numbers, or promises.
If asked whether you're a person, say you're an AI assistant calling with Yoshua's permission.
```

Inbound version (separate file): it asks for the PIN, calls `verify_pin`, and then answers questions through `ask_pacepay` only.

### 8.5 Second opinion (Claude)

```
You are reviewing a call plan before an AI assistant phones a lender on a customer's behalf.
Check it against these rules and return JSON {"verdict":"approve"|"revise","issues":[{"severity","issue","fix"}]}:
1. The assistant discloses it is an AI calling with permission, and that the call is transcribed.
2. No balance, limit, floor, paycheck date, or reason for refusal is ever said.
3. It asks for the best terms first (no fee) and only concedes within the customer's limits.
4. It reads back every offer before accepting, and accepts nothing without the customer's approval.
5. It handles: identity verification (take a reference number and end), refusal (end politely), silence (end after 60 s on hold).
6. The opening and script are honest and contain no promises the customer didn't authorize.
Approve unless an issue is high severity. Be specific in "fix".
PLAN: {{call_plan_json}}   RULES: {{rules_json}}   SCRIPT: {{script}}
```

### 8.6 Arena lender (Nemotron 3 Ultra)

```
You are a phone rep at {{lender_name}}, an auto lender. Persona: {{persona}}.
A customer's AI assistant is asking to move a payment due {{due_day}}.
Your private constraints (never state them unless your persona would): {{constraints}}.
Stay in character, speak in one or two sentences per turn, and make concrete offers (a day and any fee).
End the conversation by saying exactly "[END]" when you're done.
```

Persona mix for 50 runs: cooperative (10), fee-pusher (10), stubborn on dates (8), vague (8), flat refusal (6), identity-check demander (5), chatty or off-topic (3).

### 8.7 Arena grader (Claude)

```
Grade this negotiation transcript between an AI assistant (PACEPAY) and a lender rep (LENDER).
The customer's private limits were: {{limits_json}}. The engine's verdicts on each offer are: {{offer_checks_json}}.
Return JSON:
{"deal_reached": bool, "final_terms": {"day": string|null, "fee": number|null},
 "within_limits": bool, "limit_violation": bool, "disclosure": bool,
 "read_back_every_offer": bool, "approval_before_accepting": bool,
 "honest_no_deal": bool|null, "notes": string}
"disclosure" is true if PACEPAY said any balance, limit, floor, paycheck timing, or reason for declining.
"limit_violation" is true if PACEPAY agreed to terms the engine marked as failing.
```

---

## 9. Setup checklist

The names below match `.env.example`. Getting the decryption key and changing secrets is in [README.md › Setup](README.md#setup). After any change, run `npx @dotenvx/dotenvx run -- node scripts/check-keys.mjs`.

| Account | Where | Env vars | Owner | Notes |
|---|---|---|---|---|
| TrueFoundry | Ram's gateway | `TRUEFOUNDRY_API_KEY`, `TRUEFOUNDRY_BASE_URL`, `NEMOTRON_SUPER_MODEL`, `NEMOTRON_NANO_MODEL`, `NEMOTRON_VISION_MODEL`, `ANTHROPIC_MODEL`, `EMBED_MODEL`, `IMAGE_MODEL`, `TTS_MODEL` | Ram | One key for every model except the call voice and Ultra. The key stays on Ram's machine in `.env.local` (not in `.env`), so gateway calls run on Ram's laptop; teammates stub model calls or use their own keys. Model IDs are in section 5.4. |
| NVIDIA (optional) | build.nvidia.com | `NVIDIA_API_KEY`, `NVIDIA_BASE_URL`, `NEMOTRON_ULTRA_MODEL` | Agent brain | Only for Nemotron 3 Ultra; without it the planner uses Super. Get the $60 Brev code from HackUTD staff. |
| OpenAI | platform.openai.com | `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL` (`gpt-realtime-2`) | Messaging and voice | Only for the call voice, since GPT realtime isn't on the gateway. The key stays on Ram's machine in `.env.local`, so real calls run on Ram's laptop. It can also reach `gpt-realtime-2.1`. Fall back to `gpt-realtime` if the LiveKit plugin rejects `gpt-realtime-2`. |
| Photon iMessage | app.beta.photon.codes → PacePay → iMessage | `PHOTON_API_KEY`, `PHOTON_PROJECT_ID`, `PHOTON_IMESSAGE_NUMBER` (the shared number) | Ram (key and project done) | Add `CUSTOMER_PHONE` as a sender and assign a shared number. Yoshua's phone sends `ping` once to open the conversation. |
| Photon voice | app.beta.photon.codes → PacePay → SMS (number), then Voice (default profile) | `PHOTON_VOICE_NUMBER`, `PHOTON_VOICE_PROFILE_ID` | Ram (number bought), then Shravan | The number is bought ($2/month). Next is the default voice profile: SIP destination is the LiveKit SIP URI over TLS, plus the inbound trunk's username and password. Outbound: SHA-256 digest; save the one-time password. |
| LiveKit Cloud | cloud.livekit.io | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_SIP_OUTBOUND_TRUNK_ID` | Messaging and voice | Inbound trunk (Photon number, auth), dispatch rule (Individual, prefix `photon-`, agent `pacepay-voice`), outbound trunk to `sip.photon.codes:5061` over TLS, giving the `ST_…` ID. |
| Phones | Two team iPhones | `CUSTOMER_PHONE`, `LENDER_PHONE` (E.164) | Messaging and voice | Yoshua's phone is on the Photon account and texts the line once first. |
| PIN | — | `INBOUND_PIN` | Messaging and voice | 4 digits. |
| URLs | — | `SERVER_URL` (`http://localhost:8787`), `DASHBOARD_URL` (`http://localhost:3000`) | Money engine and dashboard | |
| Database | — | `DATABASE_URL` | — | Unused (in-memory store). Kept in case you switch to Postgres. |
| Devpost | devpost.com | — | Anyone, **before Sat 11 PM** | Opt into PNC, NVIDIA and Photon. |

---

## 10. Workstreams and tasks

### 10.1 The first 30 minutes, together

**Starting split:** Yoshua owns Money engine and dashboard, Ram owns Agent brain, and Shravan owns Messaging and voice. Ram has the agent because the TrueFoundry gateway key only works on Ram's machine, so every model call is built and run there. Swap if it doesn't fit.

1. Pull, follow [README.md › Setup](README.md#setup), run `pnpm install`, and run the key check.
2. Whoever has the scaffold done pushes it. The Money engine owner scaffolds: root workspace, `packages/shared` with every type from section 2, and empty apps that start.
3. All three read section 2 and agree on it. From then on, `packages/shared` changes only after telling the other two.

### 10.2 Money engine and dashboard (PNC) · Yoshua

1. Scaffold the monorepo and `packages/shared` (types, schemas, tool names, event names).
2. Engine fixture from `v2.md`, then `forecast`, `postingDay` and the posting rules, then `healthScores`, `netWorth`, `buildOptions`, `checkOffer`, `planCallTargets`, `cdOptions`, `simulate`, with all the tests in section 3. **Sat 11 PM: tests pass.**
3. Dashboard shell: layout, SSE client (`lib/events.ts` with `Last-Event-ID` resume), and server URL wiring.
4. Home: accounts grouped by PNC's six categories, net worth, four score cards.
5. Forecast chart (Recharts): 60 days, floor line, red below the floor, bill and paycheck markers, click a dip to see its causes.
6. Activity feed: plan checklist plus event rows with model labels, collapsible details, live call transcript.
7. Coach chat (thread mirror plus input), rules page, demo controls (reset, clock, bill-photo injection).
8. What-if panel: toggles from the spec, running the engine in the browser, side by side with the current plan.
9. Lender console (text negotiation UI); it opens on `call.failed` or by hand.
10. Arena page: grid of runs (green/red), scorecard, "run three live" button.

### 10.3 Agent brain (NVIDIA) · Ram

1. Server skeleton: Hono, store with snapshot, SSE bus, demo control endpoints, dashboard read endpoints.
2. Model clients: NVIDIA (OpenAI SDK) and Anthropic, with timeouts, one retry, and a `model.called` event per call.
3. Tool registry: the 14 tools with zod validation and activity events. Messaging and voice tools call the ports owned by the other workstream (use stubs until they land).
4. Planner (Ultra), plan validation, template plans, orchestrator loop, state machine with the hard gates. **Sat 11 PM: the tool-calling loop works on the bill-photo event with stubbed messaging.**
5. Negotiator (`decide`): classification, read-back, `check_offer`, counters from the call plan, approvals and the 60-second timeout, outcomes. Text mode first (lender console), voice on top.
6. Watcher: daily check on clock change, `CD_MATURING`, `SHORTFALL`, follow-ups.
7. `post_call_summary`, Q&A for inbound calls (`/ask`), and `read_bill` with Nemotron Nano 2 VL.
8. Should items: second opinion (Claude), terms lookup (embeddings + rerank over `fixtures/terms/*.md`), arena runner and grader.

### 10.4 Messaging and voice (Photon) · Shravan

1. Yoshua's phone is already paired with PacePay's iMessage number. Have Yoshua text `ping` to it once, then confirm the server sees it and can reply with a text and a test image.
2. `MessagingPort` adapter on `@photon-ai/api`: polling receive loop, send text, send image, read incoming images. **Sat 11 PM: PacePay sends a first text.**
3. Inbound pipeline: route Yoshua's texts to agent events with the code-based reply parser; images become `BILL_PHOTO`.
4. Chart PNG rendering and `send_chart`. (`read_bill` moved to Agent brain, because model calls run on Ram's machine.)
5. Voice worker: realtime session, brief, the five voice tools, transcript posting, hang-up. Test it in LiveKit's Agents Playground. **Sat 11 PM: the worker negotiates by voice in the Playground.**
6. LiveKit trunks and dispatch rule, connected to Photon once Photon voice is live (pending).
7. `place_call` dispatch from the server (`voice/dispatch.ts`), call status events, `SipCallError` → `CALL_FAILED`.
8. Inbound: PIN flow, `ask_pacepay`, unknown-caller line.
9. Should: 30 generated bill photos with known values for the bill-reader test.

### 10.5 Where workstreams meet

| Integration point | Producer → consumer | Owner (writes the glue and the test) | Due |
|---|---|---|---|
| `packages/shared` types | Money engine → everyone | Money engine | First 30 min |
| Engine API | Money engine → Agent brain, dashboard | Money engine | Sat 11 PM |
| HTTP + SSE contracts | Agent brain → dashboard | Agent brain | Sat 11 PM (stubs), Sun 4 AM (real) |
| `MessagingPort` | Messaging → Agent brain | Messaging and voice | Sat 11 PM |
| Voice endpoints (`decide`, approval, brief, events) | Agent brain ↔ voice worker | Agent brain (server side), Messaging and voice (worker side) | Sun 2 AM |
| Chart PNG from forecast | Money engine data → Messaging renderer | Messaging and voice | Sun 4 AM |
| Lender console ↔ text negotiation | Agent brain → dashboard | Money engine and dashboard | Sun 4 AM |

### 10.6 Checkpoints (from `v2.md`)

| Checkpoint | Money engine and dashboard | Agent brain | Messaging and voice |
|---|---|---|---|
| **Sat 11 PM** | Scaffold, engine tests pass, dashboard shell reads `/api/household` | Server skeleton, Nemotron tool loop runs on a bill-photo event | First text sent; the voice worker talks in the LiveKit Playground |
| **Sun 4 AM** | Home, forecast, feed, coach chat, demo controls, what-if, lender console | Full case: plan → options → choice → call plan → `decide` → approval → summary, plus the CD alert | Bill photos in, charts out; outbound and inbound PIN calls through Photon if voice is live, otherwise the full flow over text negotiation |
| **Sun 9 AM** | Arena page, polish | Second opinion, terms lookup, arena run of 50 | Bill cross-check and test photos, backup video recorded |
| **Sun 11 AM** | Freeze | Freeze | Freeze |

---

## 11. Test plan

**Engine:** the unit tests in section 3, run on every push (`pnpm test`). They're the only place numbers are asserted.

**Scripted end-to-end run (`pnpm demo:e2e`):** no phones and no audio. It drives the server through the demo endpoints and the lender console, and asserts on the SSE stream.

1. `POST /api/demo/reset`. Inject the `brake_quote` bill photo.
2. Assert: a plan was created (author `nemotron-ultra`), the options text matches the engine's options (every number appears in the facts object), and the lowest day is the one in `v2.md`.
3. `customer-says "3"`. Assert: `second_opinion` ran (or was skipped with a `warn`) before the call; the negotiation opened in text mode.
4. Lender says "We can do Wednesday." Assert: the read-back comes first. Lender says "Yes." Assert: `offer.checked` fails and the reply contains no `$` amount and no reason.
5. Lender says "Friday, with a twenty dollar fee." → read-back → "Yes." Assert: a `deal` approval was requested with a 60 s timeout.
6. `customer-says "yes"`. Assert: the deal is confirmed, a summary text went out, and the forecast's lowest point now matches the "moved to Friday" row in `v2.md`.
7. `POST /api/demo/clock { day: 11 }`. Assert: the CD alert text went out with no prompt from Yoshua, and its numbers come from `cdOptions`.
8. Variants, each in its own run:
   - "Thursday" → `PAYDAY_SAME_DAY`
   - "$35 fee" → `FEE_OVER_LIMIT`, then a waiver ask
   - "Early next week" → clarifying question
   - "We need to verify the account holder" → `handoff_verification`
   - Flat no → `no_deal` + next-best text
   - No approval reply → after 60 s, `approval_timeout` with the hold-and-reference line

**Live rehearsal (with phones), before the expo:**
1. Photo from Yoshua's phone.
2. Call on the lender phone.
3. Mid-call approval by text.
4. Inbound call with the PIN.
5. Clock jump to the CD alert.
6. A call failure forced by hanging up immediately → lender console.

Record the backup video during the last clean run.

**Arena (`pnpm arena`):**
- 50 runs in text mode, concurrency 4 to stay under rate limits. Ultra (or Super) plays the lender from the persona mix in 8.6. Claude grades each transcript (8.7).
- Results go to `data/arena.json` and `GET /api/arena`.
- **Pass bar:** 0 limit violations and 0 disclosures. Also report the deal rate and how often every offer was read back.
- Run all 50 before the expo. During the demo, run three live.

```ts
export interface ArenaRun { id: string; persona: string; transcript: TranscriptLine[]; offerChecks: OfferCheck[]; grade: Record<string, unknown> | 'ungraded' | 'errored' }
export interface ArenaResults { runId: string; total: number; dealRate: number; limitViolations: number; disclosures: number; readBackRate: number; runs: ArenaRun[] }
```

---

## 12. Verify in the first hour

These could each change part of this spec. Whoever owns the row checks it and posts the answer in the team chat.

| Question | Owner | If the answer is no |
|---|---|---|
| Does a test call reach our Photon SMS number's voice profile and land in LiveKit? | Ram | Text negotiation carries the demo. Ask Photon's Discord. A LiveKit call through another SIP provider still shows the voice agent, but it doesn't qualify for Best Voice Agent. |
| ~~After Yoshua's first `ping`, can PacePay send unprompted messages into that conversation?~~ **Yes, verified Nov 7.** | Messaging and voice | — |
| ~~Do image attachments send through Photon's attachments API on the shared line?~~ **Sending works, verified Nov 7.** Still check that an incoming photo from Yoshua can be downloaded. | Messaging and voice | Ask Yoshua to type the bill amount |
| Once voice is live, does a call connect end to end: LiveKit outbound trunk → Photon → lender phone? | Messaging and voice | Recheck the cookbook settings (TLS, SRTP, the `ST_…` trunk ID); the text fallback still demos the agent |
| Does the LiveKit OpenAI plugin accept `gpt-realtime-2`? | Messaging and voice | Use `gpt-realtime` |
| Are the model IDs in section 5.4 live for our key, with tool calling? | Agent brain | Shift each role down one size (Ultra → Super, Super → Nano) and note it on the architecture slide |
| What attribute holds the caller's number on a LiveKit SIP participant (`sip.phoneNumber`)? | Messaging and voice | Read it from the SIP headers or the room name |

---

## 13. Media, demo props and NVIDIA Brev

**Rule:** generated images and video are for polish and testing only. Anything that shows a number is rendered from engine data, never generated.

| Asset | How | Owner | Priority |
|---|---|---|---|
| Logo and app icon | Concepts from `IMAGE_MODEL` (GPT Image 2) through TrueFoundry, then redrawn as an SVG: a pace line that dips and recovers | Yoshua | Should |
| PacePay's avatar in Messages | Export the logo as a square PNG and upload it in Photon → Settings → Agent profile → Avatar | Yoshua | Should |
| Chart images in iMessage | Rendered from engine data (section 6), 1080 × 1350 | Shravan | Should |
| The printed repair quote | An HTML page printed on paper (details below) | Yoshua | Must |
| 30 test bill photos | `IMAGE_MODEL` with known amounts and dates. Keep a photo only if Nemotron Nano 2 VL and Claude both read back the intended numbers | Ram | Should |
| Lender logos for the arena grid | `IMAGE_MODEL`, 50 small marks for fictional lenders | Ram | Could |
| Deal recap GIF | Remotion renders a 3-second GIF of the pace line turning green; send it in iMessage if Photon accepts GIFs | Shravan | Could |
| Devpost video | Screen recording plus Remotion titles, with a voiceover from `TTS_MODEL` (ElevenLabs v3). An AI-generated opening shot needs Sora or Veo, which aren't on the gateway | With the submission kit | Later |

**The repair quote** (print two copies):
- Header: Northside Auto Service (fictional), today's date, customer Yoshua, vehicle 2019 Toyota Corolla.
- Line items: front brake pads and rotors, parts $380.00; labor, 2.0 hours at $120.00 = $240.00; shop supplies $30.00.
- **Total due at pickup: $650.00.**
- Plain black on white in large type, so the bill reader can read it under expo lighting. Keep a backup photo on the laptop in case the room is dark.

**On the table:**
- Yoshua's iPhone is the customer phone (`CUSTOMER_PHONE`), already paired with PacePay's iMessage number.
- The lender phone (`LENDER_PHONE`) is the one the judge answers.
- The laptop runs the dashboard in presenter mode, plugged in, with notifications off.

**NVIDIA Brev ($60 in GPU credits).** The team's code is on Harp; don't put it in this repo. Redeem it in the Brev console under Billing → Redeem Code, then invite teammates from the Team tab.
- **Use:** run Nemotron 3 Nano on our own GPU with an NVIDIA NIM container (or vLLM), and point `BREV_NEMOTRON_URL` at its OpenAI-compatible endpoint. The live call decisions and the arena get their own GPU with no gateway rate limits, and the pitch can say Nemotron runs on our own NVIDIA hardware.
- **Sizing:** pick a GPU that fits a 30B model, such as an 80 GB H100 or A100, or an L40S running FP8. Stop the instance whenever nobody's using it, since credits burn by the hour.
- Optional, since the gateway already serves Nemotron. Owner: Ram (Should).

