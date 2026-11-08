/**
 * derive(): demo mode's machine -> DashboardState, the way the mockup's renderVals() turns its
 * state into what the page shows. Every number comes from the engine (memoized in demo-engine.ts):
 * the chart line and ghost, the status line, the panel step, the offer verdicts, the what-if
 * result and the health stats. Owned by: dash-demo.
 */
import {
  CATEGORIES,
  ITEM_IDS,
  formatDate,
  formatMoney,
  formatMonths,
  formatOneDecimal,
  formatPercent,
  formatShortDate,
  formatWholeDollars,
  limitsText,
  dealApprovalText,
  offerVerdict,
  statusLineText,
  weekdayOf,
  type Account,
  type Approval,
  type ArenaResults,
  type Bill,
  type Call,
  type Case,
  type CaseState,
  type Category,
  type Change,
  type Forecast,
  type HealthScore,
  type Negotiation,
  type Offer,
  type OfferCheck,
  type Plan,
  type PlanStep,
  type PlanStepStatus,
  type TranscriptLine,
} from '@pacepay/shared';
import type {
  CallView,
  CaseView,
  ChartView,
  DashboardState,
  HouseholdSummary,
  OfferRow,
  PanelView,
  WhatIfKey,
  WhatIfRow,
  WhatIfView,
} from './view-model';
import {
  CASE_DAY,
  REPAIR_MERCHANT,
  cdMaturesOn,
  debtAndIncome,
  essentialsTotal,
  householdAt,
  netWorthAt,
  runCdOptions,
  runForecast,
  runOfferChanges,
  runSimulate,
  runTargets,
  type OfferTerms,
} from './demo-engine';
import {
  BILL_ID,
  CALL_ID,
  CASE_ID,
  DEAL_REFERENCE,
  MINUTE,
  NEGOTIATION_ID,
  PLAN_ID,
  REPAIR_STEPS,
  SECONDS_PER_LINE,
  aboutCents,
  arenaSample,
  eveningAt,
  lenderScript,
  offerLabel,
} from './demo-script';
import {
  CAR_PAYMENT_DAY,
  PAYCHECK_LATE_DAYS,
  agreedChanges,
  alertMessage,
  baseChanges,
  caseForecast,
  checkFor,
  findOption,
  inCall,
  lastOffer,
  lateCase,
  latePaycheck,
  lowestOf,
  needsHelp,
  nextCallLine,
  nextPayday,
  optionRow,
  planChanges,
  rankedOptions,
  savingsAmount,
  targetDay,
  type DemoMachine,
} from './demo-case';

const money = (c: number) => formatMoney(c);
const whole = (c: number) => formatWholeDollars(c);
const CHART_DAYS = 60;
const SCORE_DAYS = 30;

let arenaCache: ArenaResults | null = null;
const arena = () => (arenaCache ??= arenaSample());

// ---------------------------------------------------------------------------
// What-if
// ---------------------------------------------------------------------------

interface WhatIfResult {
  view: WhatIfView;
  forecast: Forecast;
  /** A row that moves checking is on (the CD row only moves savings and the card). */
  movesChecking: boolean;
}

/** The fee the scripted call ends on ($20): the what-if's "Move the car payment" row uses it. */
function scriptedDealFee(): number {
  const offers = lenderScript().filter((l) => l.offer);
  return offers[offers.length - 1]?.offer?.fee ?? 0;
}

function daysBelowZero(fc: Forecast, days: number): number {
  return fc.days.slice(0, days).filter((d) => d.close < 0).length;
}

function isRepairPaid(c: Change): boolean {
  return c.type === 'add_item' && c.item.id === 'bill';
}

function whatIf(m: DemoMachine, plan: Change[], planFc: Forecast): WhatIfResult {
  const r = m.rules;
  const range = m.ui.range;
  const to = targetDay(m);
  const fee = scriptedDealFee();
  // Once Yoshua says the paycheck is late it is in the plan; the row keeps naming the same move.
  const lp = m.paycheck === 'late' ? latePaycheck(m) : null;
  const payday = lp ? lp.payday : nextPayday(planFc);
  const late = lp ? lp.late : payday === null ? null : payday + PAYCHECK_LATE_DAYS;
  const matures = cdMaturesOn(r);
  const cardOpt = findOption(m, 'card');

  const available: Record<WhatIfKey, boolean> = {
    car: m.day === CASE_DAY && m.stage !== 'done' && to >= 0,
    late: m.day === CASE_DAY && late !== null && m.paycheck !== 'late',
    card: m.day === CASE_DAY && !!cardOpt && !(m.stage === 'done' && m.chosen === 'card'),
    cd: m.day < matures,
  };
  const on = (k: WhatIfKey) => m.ui.whatIf[k] && available[k];

  let changes: Change[] = [...plan];
  if (on('card') && cardOpt) {
    const charge = cardOpt.changes.find((c) => c.type === 'charge_card');
    changes = changes.flatMap((c) => (isRepairPaid(c) ? (charge ? [charge] : []) : [c]));
  }
  if (on('car')) changes = [...changes, ...runOfferChanges(r, { newDay: to, fee })];
  if (on('late') && late !== null) changes = [...changes, { type: 'move_item', itemId: ITEM_IDS.paycheck, toDay: late }];
  let cdLine: string | null = null;
  if (on('cd')) {
    const payoff = runCdOptions(r, changes, m.day).find((o) => o.id === 'cd_payoff_card');
    if (payoff) {
      changes = [...changes, ...payoff.changes];
      const t = payoff.tradeoffs;
      cdLine = `Emergency fund: ${formatOneDecimal(t.emergencyMonthsBefore ?? 0)} → ${formatOneDecimal(t.emergencyMonthsAfter ?? 0)} months, about ${whole(aboutCents(t.yearlyInterestSaved ?? 0))} a year saved`;
    }
  }
  const sim = runSimulate(r, changes, m.day);

  const extraLines: string[] = [];
  if (on('card') && cardOpt) {
    const t = cardOpt.tradeoffs;
    extraLines.push(`Card use: ${formatPercent(t.creditUseBefore ?? 0)} → ${formatPercent(t.creditUseAfter ?? 0)}, about ${whole(t.monthlyInterest ?? 0)}/mo interest`);
  }
  if (cdLine) extraLines.push(cdLine);
  const anyOn = (Object.keys(available) as WhatIfKey[]).some(on);
  if (!anyOn) extraLines.push('Pick a change below to see what happens.');

  const row = (key: WhatIfKey, label: string, detail: string): WhatIfRow => ({ key, label, detail, checked: on(key), available: available[key] });
  const rows: WhatIfRow[] = [
    row('car', `Move the car payment to ${to >= 0 ? weekdayOf(to) : 'later'}`, to >= 0 ? `${formatDate(to)} with a ${whole(fee)} fee` : 'No day works'),
    row(
      'late',
      payday !== null && late !== null ? `Paycheck lands ${weekdayOf(late)}, not ${weekdayOf(payday)}` : 'Paycheck lands late',
      payday !== null && late !== null ? `${formatDate(late)} instead of ${formatDate(payday)}` : '',
    ),
    row('card', 'Put the repair on your card', `About ${whole(cardOpt?.tradeoffs.monthlyInterest ?? 0)}/mo interest`),
    row('cd', 'Use the CD to pay off your card', `When it matures ${formatDate(matures)}`),
  ];

  return {
    forecast: sim.forecast,
    movesChecking: on('car') || on('late') || on('card'),
    view: {
      lowestNow: lowestOf(planFc, range),
      lowestWhatIf: lowestOf(sim.forecast, range),
      daysBelowZeroNow: daysBelowZero(planFc, range),
      daysBelowZeroWhatIf: daysBelowZero(sim.forecast, range),
      extraLines,
      rows,
    },
  };
}

// ---------------------------------------------------------------------------
// Health stats: the engine's values, in UI.md's words
// ---------------------------------------------------------------------------

function statScores(m: DemoMachine, scores: HealthScore[], plan: Change[], accounts: Account[]): HealthScore[] {
  const r = m.rules;
  const essentials = essentialsTotal(r);
  const matures = cdMaturesOn(r);
  return scores.map((s) => {
    if (s.key === 'emergency_fund') {
      const savings = Math.round(s.value * essentials);
      let improve = s.improve;
      if (m.day < matures) {
        const after = runCdOptions(r, plan, m.day).find((o) => o.id === 'cd_payoff_card')?.tradeoffs.emergencyMonthsAfter;
        if (after != null) improve = `The CD on ${formatShortDate(matures)} could take it to ${formatOneDecimal(after)} months.`;
      }
      return { ...s, reason: `Savings (${money(savings)}) cover ${formatMonths(s.value)} of essentials (${money(essentials)} a month).`, improve };
    }
    if (s.key === 'credit_use') {
      const limit = accounts.filter((a) => a.kind === 'credit_card').reduce((t, a) => t + (a.limit ?? 0), 0);
      const owed = Math.round(s.value * limit);
      return {
        ...s,
        reason: `${money(owed)} of your ${money(limit)} limit.`,
        improve: s.color === 'green' ? 'On track.' : `Under ${money(Math.floor(limit * 0.3))} gets you below 30%.`,
      };
    }
    if (s.key === 'debt_to_income') {
      const { debt, income } = debtAndIncome(r);
      return { ...s, reason: `${money(debt)} a month in debt payments on ${whole(income)} a month of income.`, improve: s.color === 'green' ? '' : s.improve };
    }
    return s;
  });
}

// ---------------------------------------------------------------------------
// The case: plan checklist, approvals, the bill
// ---------------------------------------------------------------------------

const CASE_STATES: Record<DemoMachine['stage'], CaseState> = {
  home: 'AWAITING_CHOICE',
  limits: 'AWAITING_LIMITS',
  call: 'NEGOTIATING',
  approve: 'AWAITING_APPROVAL',
  done: 'DONE',
};

function planSteps(m: DemoMachine, help: boolean, dealDay: number | null): PlanStep[] {
  const status = (i: number): { status: PlanStepStatus; note?: string } => {
    if (!help) return { status: i <= 1 || i === 3 ? 'done' : 'skipped' };
    if (m.stage === 'done' && m.chosen && m.chosen !== 'move_payment') {
      if (i <= 4 || i === 12 || i === 13) return { status: 'done' };
      return { status: 'skipped' };
    }
    const doneN = { home: 4, limits: 7, call: 10, approve: 11, done: 14 }[m.stage];
    if (i === 14 && m.stage === 'done') {
      const reminder = dealDay !== null ? dealDay - 1 : null;
      if (reminder !== null && m.day > reminder) return { status: 'done' };
      return { status: 'pending', note: reminder !== null ? `Set for ${formatShortDate(reminder)}` : undefined };
    }
    if (i < doneN) return { status: 'done', note: i === 10 && m.textMode ? 'By text' : undefined };
    if (i === doneN && m.stage !== 'done') return { status: 'running', note: i === 10 && m.textMode ? 'By text' : undefined };
    return { status: 'pending' };
  };
  return REPAIR_STEPS.map((s, i) => {
    const st = status(i);
    return { id: `step-${i + 1}`, kind: s.kind, title: s.title, model: s.model, status: st.status, ...(st.note ? { note: st.note } : {}) };
  });
}

function approvals(m: DemoMachine, help: boolean, dealCheck: OfferCheck | null): Approval[] {
  if (!help) return [];
  const ranked = rankedOptions(m);
  const list: Approval[] = [];
  const idx = m.chosen ? ranked.findIndex((o) => o.id === m.chosen) + 1 : 0;
  list.push({
    id: 'approval-choice',
    kind: 'option_choice',
    prompt: alertMessage(m),
    choices: ranked.map((_, i) => String(i + 1)),
    optionIds: ranked.map((o) => o.id),
    status: m.stage === 'home' ? 'pending' : 'answered',
    ...(idx ? { answer: String(idx) } : {}),
    caseId: CASE_ID,
    requestedAt: eveningAt(MINUTE.alert),
    ...(m.stage !== 'home' ? { resolvedAt: eveningAt(MINUTE.pick) } : {}),
  });
  if (m.chosen === 'move_payment') {
    list.push({
      id: 'approval-limits',
      kind: 'call_limits',
      prompt: limitsText({ toDay: targetDay(m), feeLimit: m.rules.feeLimit }),
      choices: ['yes', 'no'],
      status: m.stage === 'limits' ? 'pending' : 'approved',
      ...(m.stage !== 'limits' ? { answer: 'yes', resolvedAt: eveningAt(MINUTE.limits) } : {}),
      caseId: CASE_ID,
      requestedAt: eveningAt(MINUTE.pick),
    });
  }
  if ((m.stage === 'approve' || m.stage === 'done') && m.chosen === 'move_payment' && m.deal && dealCheck) {
    list.push({
      id: 'approval-deal',
      kind: 'deal',
      prompt: dealApprovalText({ toDay: dealCheck.postsOnDay, fee: m.deal.fee, checkingFloor: m.rules.checkingFloor }),
      choices: ['yes', 'no'],
      status: m.stage === 'approve' ? 'pending' : 'approved',
      ...(m.stage === 'done' ? { answer: 'yes', resolvedAt: eveningAt(MINUTE.done) } : {}),
      ...(m.textMode ? {} : { callId: CALL_ID }),
      caseId: CASE_ID,
      negotiationId: NEGOTIATION_ID,
      requestedAt: eveningAt(MINUTE.approve),
      timeoutMs: 60_000,
    });
  }
  return list;
}

function caseView(m: DemoMachine, help: boolean, plan: Change[], dealCheck: OfferCheck | null): CaseView {
  const base = baseChanges(m);
  const title = `The ${whole(m.billAmount)} repair`;
  const appr = approvals(m, help, dealCheck);
  const calling = m.chosen === 'move_payment' && m.stage !== 'limits' && m.stage !== 'home';
  const c: Case = {
    id: CASE_ID,
    title,
    state: m.stage === 'call' && m.textMode ? 'TEXT_NEGOTIATION' : help ? CASE_STATES[m.stage] : 'DONE',
    planId: PLAN_ID,
    billId: BILL_ID,
    ...(m.chosen ? { chosenOption: m.chosen } : {}),
    ...(calling ? { negotiationId: NEGOTIATION_ID, callId: CALL_ID } : {}),
    approvalIds: appr.map((a) => a.id),
    kind: 'bill',
    options: help ? rankedOptions(m) : [],
    ...(m.stage === 'done' ? { acceptedChanges: plan } : { baseChanges: base }),
    openedAt: eveningAt(MINUTE.photo),
    ...(m.stage === 'done' ? { closedAt: eveningAt(MINUTE.done) } : {}),
  };
  const p: Plan = {
    id: PLAN_ID,
    caseId: CASE_ID,
    eventId: 'event-photo',
    goal: title,
    author: 'nemotron-ultra',
    writtenBy: 'nemotron-ultra',
    steps: planSteps(m, help, dealCheck?.postsOnDay ?? null),
  };
  const bill: Bill = {
    id: BILL_ID,
    caseId: CASE_ID,
    merchant: REPAIR_MERCHANT,
    amount: m.billAmount,
    dueDay: CASE_DAY,
    description: 'Brake repair',
    confidence: 0.94,
    confirmed: m.stage !== 'home',
    source: 'photo',
  };
  return { case: c, plan: p, approvals: appr, bill };
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

function callView(m: DemoMachine): CallView {
  const startedAt = eveningAt(MINUTE.call);
  const transcript: TranscriptLine[] = m.lines.map((l, i) => ({
    at: eveningAt(MINUTE.call, i * SECONDS_PER_LINE),
    speaker: l.who === 'pacepay' ? 'pacepay' : 'counterparty',
    text: l.text,
  }));
  const offers: OfferRow[] = [];
  const checks: OfferCheck[] = [];
  const negOffers: Offer[] = [];
  m.lines.forEach((l, i) => {
    if (!l.offer) return;
    const check = checkFor(m, l.offer);
    checks.push(check);
    const id = `${check.offerId}#${i}`;
    offers.push({ offerId: id, newDay: l.offer.newDay, fee: l.offer.fee, label: offerLabel(l.offer), verdict: offerVerdict(check), pass: check.pass });
    negOffers.push({ id, negotiationId: NEGOTIATION_ID, itemId: 'auto_payment', newDay: l.offer.newDay, fee: l.offer.fee, heard: l.text, readBackConfirmed: true });
  });
  const targets = runTargets(m.rules, baseChanges(m));
  const negotiation: Negotiation = {
    id: NEGOTIATION_ID,
    caseId: CASE_ID,
    counterpartyId: 'auto_lender',
    itemId: 'auto_payment',
    channel: m.textMode ? 'text' : 'voice',
    callPlan: {
      goal: `Move the car payment from ${formatDate(CAR_PAYMENT_DAY)} to a day after payday`,
      targetDay: targets.targetDay,
      acceptableDays: targets.acceptableDays,
      feeLimit: targets.feeLimit,
      openingAsk: `Ask to move it to ${formatDate(targets.targetDay)} with no fee`,
      walkAway: `Stop if no date works or the fee is over ${whole(targets.feeLimit)}`,
      fallbackText: "Your lender couldn't move it within your limits. Nothing changed.",
    },
    offers: negOffers,
    state: m.stage === 'approve' ? 'awaiting_approval' : m.lines[m.lines.length - 1]?.offer ? 'countering' : 'listening',
    checks,
    transcript,
    callId: CALL_ID,
  };
  const call: Call = {
    id: CALL_ID,
    direction: 'outbound',
    counterpartyId: 'auto_lender',
    phone: '+15555550142',
    room: 'photon-demo-1',
    status: m.textMode ? 'failed' : m.stage === 'approve' ? 'holding_for_approval' : 'active',
    negotiationId: NEGOTIATION_ID,
    transcript,
    startedAt,
  };
  const next = nextCallLine(m);
  return {
    call,
    negotiation,
    textMode: m.textMode,
    elapsedSec: m.lines.length * SECONDS_PER_LINE,
    transcriptTail: transcript.slice(-4),
    offers,
    canAdvance: m.stage === 'call' && next !== null,
    atEnd: m.stage === 'call' && next === null,
    lenderNext: next?.who === 'lender' ? next.text : null,
  };
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

function coveredThrough(m: DemoMachine, plan: Change[]): number {
  const fc = runForecast(m.rules, plan, CASE_DAY, CHART_DAYS);
  const below = fc.days.find((d) => d.belowFloor);
  const last = CASE_DAY + SCORE_DAYS;
  return below ? Math.max(CASE_DAY, Math.min(below.day - 1, last)) : last;
}

function panelView(m: DemoMachine, help: boolean, plan: Change[], dealCheck: OfferCheck | null): PanelView {
  const r = m.rules;
  if (m.ui.whatIfOpen && !inCall(m)) return { step: 'what_if' };
  if (m.cdOpen && m.day >= 11 && !m.ui.cdDismissed) {
    const opts = runCdOptions(r, plan, m.day);
    const payoff = opts.find((o) => o.id === 'cd_payoff_card');
    const renew = opts.find((o) => o.id === 'cd_renew');
    if (payoff && renew) {
      const toCard = payoff.changes.find((c) => c.type === 'pay_down');
      const toSavings = payoff.changes.find((c) => c.type === 'transfer');
      const card = toCard?.type === 'pay_down' ? toCard.amount : 0;
      const savings = toSavings?.type === 'transfer' ? toSavings.amount : 0;
      const t = payoff.tradeoffs;
      return {
        step: 'cd_alert',
        cdAmount: card + savings,
        maturesOn: cdMaturesOn(r),
        best: {
          title: 'Pay off your card, save the rest',
          detail: `${whole(card)} to the card, ${whole(savings)} to savings. Saves about ${whole(aboutCents(t.yearlyInterestSaved ?? 0))} a year, and your emergency fund goes from ${formatOneDecimal(t.emergencyMonthsBefore ?? 0)} to ${formatOneDecimal(t.emergencyMonthsAfter ?? 0)} months.`,
        },
        other: { optionId: 'cd_renew', title: 'Renew the CD', detail: `Earns about ${whole(aboutCents(renew.tradeoffs.yearlyInterestEarned ?? 0))} a year` },
      };
    }
  }

  if (m.stage === 'done' && m.paycheck === 'late' && m.day === CASE_DAY) {
    const lc = lateCase(m);
    const [best, ...others] = lc?.options ?? [];
    if (lc && best) {
      return {
        step: 'heads_up',
        lowest: lc.lowest,
        condition: `If your paycheck lands ${formatDate(lc.late.late)}.`,
        best: { optionId: best.id, title: best.title, detail: best.detail, cta: best.id === 'move_payment' ? 'Ask my lender' : 'Use savings' },
        others: others.map((o) => ({ optionId: o.id, title: o.title, detail: o.detail })),
      };
    }
  }

  switch (m.stage) {
    case 'home': {
      if (!help) return { step: 'idle' };
      const fc = caseForecast(m);
      const [best, ...others] = rankedOptions(m);
      if (!best) return { step: 'idle' };
      const b = optionRow(m, best);
      return {
        step: 'heads_up',
        lowest: { amount: fc.lowest.amount, day: fc.lowest.day },
        condition: `If you pay the ${whole(m.billAmount)} repair today.`,
        best: { optionId: best.id, title: b.title, detail: b.detail, cta: b.cta },
        others: others.map((o) => {
          const row = optionRow(m, o);
          return { optionId: o.id, title: row.title, detail: row.detail };
        }),
      };
    }
    case 'limits':
      return { step: 'limits', askFor: targetDay(m), maxFee: r.feeLimit, newCredit: 'None' };
    case 'call':
      return { step: 'call' };
    case 'approve': {
      if (!m.deal || !dealCheck) return { step: 'call' };
      return {
        step: 'approve',
        rows: [
          { label: 'Payment', before: formatDate(CAR_PAYMENT_DAY), after: formatDate(dealCheck.postsOnDay) },
          { label: 'Fee', before: money(0), after: money(m.deal.fee) },
          { label: 'Lowest', before: money(caseForecast(m).lowest.amount), after: money(dealCheck.lowest.amount) },
        ],
      };
    }
    case 'done': {
      const low = runForecast(r, plan, CASE_DAY, SCORE_DAYS).lowest;
      if (m.chosen === 'move_payment' && m.deal && dealCheck) {
        return {
          step: 'done',
          coveredThrough: coveredThrough(m, plan),
          results: [
            { label: 'Car payment', value: formatDate(dealCheck.postsOnDay) },
            { label: 'Fee', value: money(m.deal.fee) },
            { label: 'Lowest', value: money(low.amount) },
          ],
          reference: DEAL_REFERENCE,
        };
      }
      const option = m.chosen ? findOption(m, m.chosen) : undefined;
      const results: { label: string; value: string }[] = [];
      if (option?.id === 'card') {
        results.push({ label: 'Repair on your card', value: whole(m.billAmount) }, { label: 'Interest', value: `About ${whole(option.tradeoffs.monthlyInterest ?? 0)}/mo` });
      } else if (option?.id === 'savings') {
        results.push({ label: 'From savings today', value: whole(savingsAmount(option)) }, { label: 'Savings goes to', value: whole(option.tradeoffs.savingsAfter ?? 0) });
      }
      results.push({ label: 'Lowest', value: money(low.amount) });
      return { step: 'done', coveredThrough: coveredThrough(m, plan), results };
    }
  }
}

// ---------------------------------------------------------------------------
// The chart
// ---------------------------------------------------------------------------

function chartView(m: DemoMachine, planFc: Forecast, wi: WhatIfResult | null): ChartView {
  const r = m.rules;
  const range = m.ui.range;
  const offer: OfferTerms | null = inCall(m) ? lastOffer(m.lines) : null;
  let line = planFc;
  let ghost: ChartView['ghost'] = null;
  let mode: ChartView['mode'] = 'plan';
  if (wi) {
    line = wi.forecast;
    mode = 'what_if';
    if (wi.movesChecking) ghost = { forecast: planFc, label: 'Current plan' };
  } else if (m.stage === 'done' && m.paycheck === 'late') {
    // The late paycheck is in the plan now: the line before it stays as "Before".
    ghost = { forecast: runForecast(r, agreedChanges(m), m.day, CHART_DAYS), label: 'Before' };
  } else if (m.stage === 'done') {
    mode = 'done';
    ghost = { forecast: runForecast(r, baseChanges(m), m.day, CHART_DAYS), label: 'Before' };
  } else if (offer) {
    mode = 'offer';
    line = runForecast(r, [...baseChanges(m), ...runOfferChanges(r, offer)], m.day, CHART_DAYS);
    ghost = { forecast: planFc, label: 'Before' };
  }
  const lowest = lowestOf(line, range);
  const at = `${money(lowest.amount)} on ${formatDate(lowest.day)}`;
  let status = statusLineText({ lowest });
  if (mode === 'what_if' && wi?.movesChecking) status = `What if: lowest ${at}`;
  else if (mode === 'done' && lowest.amount >= r.checkingFloor) status = `${status} · on track`;
  else if (mode === 'offer') status = `This offer: lowest ${at}`;
  return { line, ghost, floor: r.checkingFloor, status, lowest, mode };
}

// ---------------------------------------------------------------------------
// derive
// ---------------------------------------------------------------------------

function byCategory(accounts: Account[]): Record<Category, Account[]> {
  const out = Object.fromEntries(CATEGORIES.map((c) => [c, [] as Account[]])) as Record<Category, Account[]>;
  for (const a of accounts) out[a.category].push(a);
  return out;
}

export function derive(m: DemoMachine): DashboardState {
  const r = m.rules;
  const help = needsHelp(m);
  const plan = planChanges(m);
  const sim = runSimulate(r, plan, m.day);
  const planFc = sim.forecast;
  const dealCheck = m.deal ? checkFor(m, m.deal) : null;
  const wi = m.ui.whatIfOpen && !inCall(m) ? whatIf(m, plan, planFc) : null;

  const hh = householdAt(r, plan, m.day);
  const accounts = hh.accounts as Account[];
  const household: HouseholdSummary = {
    personName: 'Yoshua',
    day0Date: hh.day0Date,
    checkingAccountId: 'checking',
    checkingBalance: planFc.days[0]?.open ?? 0,
    netWorth: netWorthAt(r, plan, m.day),
    accountCount: accounts.length,
    accounts,
    byCategory: byCategory(accounts),
    monthlyEssentials: essentialsTotal(r),
  };

  return {
    mode: 'demo',
    connection: 'demo',
    day: m.day,
    ui: m.ui,
    household,
    rules: r,
    forecast: planFc,
    acceptedChanges: plan,
    scores: statScores(m, sim.scores, plan, accounts),
    chart: chartView(m, planFc, wi),
    panel: panelView(m, help, plan, dealCheck),
    current: caseView(m, help, plan, dealCheck),
    call: inCall(m) ? callView(m) : null,
    whatIf: wi?.view ?? null,
    thread: m.thread,
    activity: m.activity,
    arena: arena(),
    arenaProgress: null,
    notice: m.notice,
  };
}
