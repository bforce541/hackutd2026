/**
 * Placeholder DashboardState matching the mockup's opening screen (design/mockup/Main.dc.html,
 * stage 'home', day 0): Yoshua's household, checking $1,950, "Lowest −$300 on Tue, Nov 10",
 * the Heads up panel. Owned by: dash-demo.
 *
 * The forecast here is a port of the mockup's events()/balances() so the chart has data before
 * the engine lands. Once @pacepay/engine is implemented, build these from engine.fixtures and
 * engine.forecast instead.
 */
import {
  CATEGORIES,
  DEMO_DAY0,
  dayToISODate,
  statusLineText,
  weekdayOf,
  type Account,
  type Category,
  type Forecast,
  type ForecastDay,
  type HealthScore,
  type Message,
  type ActivityEvent,
  type Rules,
} from '@pacepay/shared';
import type { DashboardState, HouseholdSummary } from './view-model';

// ---------------------------------------------------------------------------
// The mockup's scenario model (dollars there, cents here)
// ---------------------------------------------------------------------------

export interface MockScenario {
  carDay: number; // 3 = Tue, Nov 10 (the original due day)
  fee: number; // cents
  payLate?: boolean;
  repairCard?: boolean;
}

export const BASE_SCENARIO: MockScenario = { carDay: 3, fee: 0 };
export const FIXED_SCENARIO: MockScenario = { carDay: 6, fee: 2000 };

interface MockEvent {
  id: string;
  day: number;
  amount: number; // cents
  label: string;
}

export function mockEvents(s: MockScenario): MockEvent[] {
  const ev: MockEvent[] = [];
  if (!s.repairCard) ev.push({ id: 'repair', day: 0, amount: -65000, label: 'Brake repair' });
  const payDays = s.payLate ? [9, 19, 33, 47] : [5, 19, 33, 47];
  const recurring: { id: string; days: number[]; amount: number; label: string }[] = [
    { id: 'mortgage', days: [2, 32], amount: -120000, label: 'Mortgage' },
    { id: 'utilities', days: [9, 39], amount: -22000, label: 'Utilities' },
    { id: 'card_autopay', days: [12, 42], amount: -75000, label: 'Credit card payment' },
    { id: 'phone', days: [16, 46], amount: -12000, label: 'Phone and internet' },
    { id: 'personal_loan', days: [23, 53], amount: -15000, label: 'Personal loan' },
    { id: 'car_insurance', days: [25, 56], amount: -18000, label: 'Car insurance' },
    { id: 'paycheck', days: payDays, amount: 200000, label: 'Paycheck' },
  ];
  for (const r of recurring) for (const d of r.days) ev.push({ id: `${r.id}@${d}`, day: d, amount: r.amount, label: r.label });
  const moved = s.carDay !== 3;
  ev.push({ id: `auto_payment@${s.carDay}`, day: s.carDay, amount: -40000, label: moved ? 'Car payment (moved)' : 'Car payment' });
  ev.push({ id: 'auto_payment@33', day: 33, amount: -40000, label: 'Car payment' });
  if (s.fee) ev.push({ id: `fee@${s.carDay}`, day: s.carDay, amount: -s.fee, label: 'Date-change fee' });
  return ev;
}

/** A checking Forecast from the mockup's scenario, `days` long starting at `fromDay`. */
export function mockForecast(s: MockScenario, opts: { fromDay?: number; days?: number; floor?: number } = {}): Forecast {
  const from = opts.fromDay ?? 0;
  const n = opts.days ?? 60;
  const floor = opts.floor ?? 10000;
  const ev = mockEvents(s);
  let bal = 195000;
  const days: ForecastDay[] = [];
  for (let d = 0; d < from + n; d++) {
    const todays = ev.filter((e) => e.day === d);
    const open = bal;
    const debits = todays.filter((e) => e.amount < 0).reduce((a, e) => a + e.amount, 0);
    const credits = todays.filter((e) => e.amount > 0).reduce((a, e) => a + e.amount, 0);
    const intradayLow = open + debits;
    bal = intradayLow + credits;
    if (d < from) continue;
    days.push({
      day: d,
      date: dayToISODate(d),
      weekday: weekdayOf(d),
      open,
      close: bal,
      intradayLow,
      items: todays.map((e) => ({ itemId: e.id, label: e.label, amount: e.amount })),
      belowFloor: intradayLow < floor,
      negative: intradayLow < 0,
    });
  }
  let lo = days[0]!;
  for (const fd of days) if (fd.intradayLow < lo.intradayLow) lo = fd;
  return {
    accountId: 'checking',
    days,
    lowest: { amount: lo.intradayLow, day: lo.day, causeItemIds: ['mortgage@2', 'auto_payment@3'] },
  };
}

// ---------------------------------------------------------------------------
// The household (v2.md "Demo household"), as placeholder display data
// ---------------------------------------------------------------------------

export const demoAccounts: Account[] = [
  { id: 'checking', kind: 'checking', category: 'checking', name: 'Checking', isLiability: false, balance: 195000 },
  { id: 'savings', kind: 'savings', category: 'savings', name: 'Savings', isLiability: false, balance: 180000 },
  { id: 'cd', kind: 'cd', category: 'cds_iras', name: '12-month CD', isLiability: false, balance: 500000, apy: 0.041, maturesOn: 13 },
  { id: 'ira', kind: 'ira', category: 'cds_iras', name: 'Roth IRA', isLiability: false, balance: 1420000, offLimits: true },
  { id: 'auto_loan', kind: 'auto_loan', category: 'loans', name: 'Auto loan', isLiability: true, balance: 1340000, apr: 0.069, minPayment: 40000, reference: 'ending 4417' },
  { id: 'personal_loan', kind: 'personal_loan', category: 'loans', name: 'Personal loan', isLiability: true, balance: 310000, apr: 0.119, minPayment: 15000 },
  { id: 'card', kind: 'credit_card', category: 'credit_cards', name: 'Credit card', isLiability: true, balance: 280000, apr: 0.2499, limit: 500000, minPayment: 8500 },
  { id: 'mortgage', kind: 'mortgage', category: 'mortgage', name: 'Mortgage', isLiability: true, balance: 12800000, minPayment: 120000, assetValue: 18500000 },
];

function groupByCategory(accounts: Account[]): Record<Category, Account[]> {
  const out = Object.fromEntries(CATEGORIES.map((c) => [c, [] as Account[]])) as Record<Category, Account[]>;
  for (const a of accounts) out[a.category].push(a);
  return out;
}

export const demoHousehold: HouseholdSummary = {
  personName: 'Yoshua',
  day0Date: DEMO_DAY0,
  checkingAccountId: 'checking',
  checkingBalance: 195000,
  netWorth: { assets: 20795000, liabilities: 14730000, netWorth: 6065000 },
  accountCount: 8,
  accounts: demoAccounts,
  byCategory: groupByCategory(demoAccounts),
  monthlyEssentials: 306500,
};

export const demoRules: Rules = {
  checkingFloor: 10000,
  savingsFloor: 150000,
  feeLimit: 2500,
  offLimitsAccountIds: ['ira'],
  quietHours: { start: '21:00', end: '08:00' },
  paused: false,
};

export const demoScores: HealthScore[] = [
  {
    key: 'cash_cushion',
    value: -30000,
    display: '−$300',
    color: 'red',
    reason: 'Checking goes to −$300 on Tue, Nov 10.',
    improve: 'Move the car payment to Fri, Nov 13 to stay above $100.',
  },
  {
    key: 'emergency_fund',
    value: 0.587,
    display: '0.6 months',
    color: 'red',
    reason: 'Savings ($1,800) cover 0.6 months of essentials ($3,065 a month).',
    improve: 'The CD on Nov 20 could take it to 1.5 months.',
  },
  {
    key: 'credit_use',
    value: 0.56,
    display: '56%',
    color: 'red',
    reason: '$2,800 of your $5,000 limit.',
    improve: 'Under $1,500 gets you below 30%.',
  },
  {
    key: 'debt_to_income',
    value: 0.355,
    display: '35.5%',
    color: 'green',
    reason: '$1,835 a month in debt payments on $5,167 a month of income.',
    improve: 'Stay under 36%.',
  },
];

const at = (min: number) => new Date(Date.UTC(2026, 10, 8, 1, min)).toISOString(); // Sat, Nov 7, 7:xx PM in Dallas

export const demoThread: Message[] = [
  { id: 'm1', direction: 'in', channel: 'imessage', imageUrl: '/demo/brake-quote.png', text: 'Photo of the repair quote', at: at(2) },
  { id: 'm2', direction: 'out', channel: 'imessage', text: 'Got it: $650 to Northside Auto Service, due today. Checking your week.', at: at(2) },
  { id: 'm3', direction: 'out', channel: 'imessage', imageUrl: '/demo/week-chart.png', at: at(3) },
  {
    id: 'm4',
    direction: 'out',
    channel: 'imessage',
    text: [
      'Heads up: −$300 on Tue, Nov 10 if you pay the repair today (mortgage Mon, car payment Tue, paycheck Thu).',
      '1. I ask your lender to move the car payment to Fri. My pick: no new debt',
      '2. Put it on your card: about $14/mo interest',
      '3. Use $400 of savings: drops below your $1,500 floor',
      'Reply 1, 2 or 3.',
    ].join('\n'),
    at: at(3),
  },
];

export const demoActivity: ActivityEvent[] = [
  { id: 'a1', seq: 1, at: at(2), type: 'event.received', model: 'code', title: 'Photo from Yoshua' },
  { id: 'a2', seq: 2, at: at(2), type: 'plan.created', model: 'nemotron-ultra', title: 'Wrote a 15-step plan for the $650 repair' },
  { id: 'a3', seq: 3, at: at(2), type: 'tool.result', model: 'nemotron-vision', tool: 'read_bill', title: 'Read the repair quote: $650 to Northside Auto Service, due today' },
  { id: 'a4', seq: 4, at: at(3), type: 'forecast.updated', model: 'engine', title: 'Checked the week: lowest −$300 on Tue, Nov 10' },
  { id: 'a5', seq: 5, at: at(3), type: 'message.out', model: 'nemotron-super', tool: 'send_message', title: 'Texted Yoshua the options and a chart' },
];

// ---------------------------------------------------------------------------
// The opening screen
// ---------------------------------------------------------------------------

const openingForecast = mockForecast(BASE_SCENARIO);
const openingLowest14 = mockForecast(BASE_SCENARIO, { days: 14 }).lowest;

export const demoInitialState: DashboardState = {
  mode: 'demo',
  connection: 'demo',
  day: 0,
  ui: {
    tab: 'home',
    range: 14,
    presenter: false,
    statOpen: null,
    whatIfOpen: false,
    whatIf: { car: false, late: false, card: false, cd: false },
    cdDismissed: false,
  },
  household: demoHousehold,
  rules: demoRules,
  forecast: openingForecast,
  acceptedChanges: [],
  scores: demoScores,
  chart: {
    line: openingForecast,
    ghost: null,
    floor: demoRules.checkingFloor,
    status: statusLineText({ lowest: openingLowest14 }),
    lowest: { amount: openingLowest14.amount, day: openingLowest14.day },
    mode: 'plan',
  },
  panel: {
    step: 'heads_up',
    lowest: { amount: -30000, day: 3 },
    condition: 'If you pay the $650 repair today.',
    best: {
      optionId: 'move_payment',
      title: 'Move your car payment to Fri',
      detail: 'Stays above $100. Fee up to $25.',
      cta: 'Ask my lender',
    },
    others: [
      { optionId: 'card', title: 'Put it on your card', detail: 'About $14/mo interest' },
      { optionId: 'savings', title: 'Use $400 of savings', detail: 'Below your $1,500 floor' },
    ],
  },
  current: null,
  call: null,
  whatIf: null,
  thread: demoThread,
  activity: demoActivity,
  arena: null,
  arenaProgress: null,
  notice: null,
};
