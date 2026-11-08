'use client';
/**
 * Live mode: DashboardState from GET /api/snapshot plus the SSE stream, and Actions that call
 * the server (approvals through POST /api/approvals/:id, the lender console, demo controls).
 * Owned by: dash-shell.
 *
 * Shape of this file: `Raw` is what the server told us; `derive()` turns Raw + UI state into the
 * DashboardState the components read. The chart's offer line, the "Before" ghost and the what-if
 * panel run @pacepay/engine in the browser, always inside derive() (never at module scope) and
 * always falling back to the server's own forecast on error.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as engine from '@pacepay/engine';
import {
  ACCOUNT_IDS,
  API,
  CATEGORIES,
  CD_ALERT_DAY,
  HORIZON_DAYS,
  ITEM_IDS,
  billItemId,
  formatDate,
  formatDayRelative,
  formatMoney,
  formatOneDecimal,
  formatPercent,
  formatWholeDollars,
  offerVerdict,
  statusLineText,
  weekdayOf,
  type Account,
  type ActivityEvent,
  type Approval,
  type ArenaProgress,
  type ArenaResults,
  type Bill,
  type Call,
  type Case,
  type Category,
  type Change,
  type ChartRange,
  type Day,
  type Forecast,
  type HealthScore,
  type Household,
  type Lowest,
  type Message,
  type Negotiation,
  type NetWorth,
  type Offer,
  type Option,
  type OptionId,
  type Plan,
  type Rules,
  type SnapshotResponse,
  type SseEvent,
} from '@pacepay/shared';
import { apiGet, apiPost, apiPut, ServerError } from './api';
import { openEventStream } from './events';
import type {
  Actions,
  CallView,
  ChartView,
  Connection,
  DashboardState,
  HouseholdSummary,
  OfferRow,
  OptionRow,
  PanelView,
  UiState,
  UseDashboard,
  WhatIfKey,
  WhatIfRow,
  WhatIfToggles,
  WhatIfView,
} from './view-model';

// ---------------------------------------------------------------------------
// Raw server state
// ---------------------------------------------------------------------------

interface Raw {
  household: Household;
  netWorth: NetWorth;
  byCategory: Record<Category, Account[]>;
  forecast: Forecast;
  scores: HealthScore[];
  acceptedChanges: Change[];
  rules: Rules;
  thread: Message[];
  case: Case | null;
  plan: Plan | null;
  bill: Bill | null;
  approvals: Approval[];
  call: Call | null;
  negotiation: Negotiation | null;
  day: Day;
  arena: ArenaResults | null;
  arenaProgress: ArenaProgress | null;
  activity: ActivityEvent[];
  connection: Connection;
  /** Highest SSE seq applied or covered by a snapshot. */
  seen: number;
  /** State events at or below this seq are already in the snapshot; only activity/thread backfill from them. */
  floor: number;
  /** Activity at or below this seq is dropped (after a demo reset). */
  activityFloor: number;
}

function fromSnapshot(s: SnapshotResponse, prev: Raw | null): Raw {
  const cur = s.current;
  const hasCase = 'case' in cur && cur.case !== null;
  return {
    household: s.household,
    netWorth: s.netWorth,
    byCategory: s.byCategory,
    forecast: s.forecast,
    scores: s.scores,
    acceptedChanges: s.acceptedChanges,
    rules: s.rules,
    thread: prev ? mergeThread(s.thread, prev.thread) : s.thread,
    case: hasCase ? (cur as { case: Case }).case : null,
    plan: hasCase ? ((cur as { plan: Plan | null }).plan ?? null) : null,
    bill: hasCase ? ((cur as { bill: Bill | null }).bill ?? null) : null,
    approvals: hasCase ? (cur as { approvals: Approval[] }).approvals : [],
    call: s.call,
    negotiation: s.negotiation,
    day: s.day,
    arena: s.arena,
    arenaProgress: prev?.arenaProgress ?? null,
    activity: prev?.activity ?? [],
    connection: prev?.connection ?? 'connecting',
    seen: Math.max(s.lastSeq, prev?.seen ?? 0),
    floor: s.lastSeq,
    activityFloor: prev?.activityFloor ?? 0,
  };
}

function mergeThread(a: Message[], b: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const m of [...a, ...b]) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => x.at.localeCompare(y.at));
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function applyEvent(r: Raw, e: SseEvent): Raw {
  const seen = Math.max(r.seen, e.seq);
  if (e.event === 'activity') {
    if (e.seq <= r.activityFloor || r.activity.some((a) => a.id === e.data.id)) return { ...r, seen };
    return { ...r, seen, activity: [...r.activity, e.data].sort((a, b) => a.seq - b.seq) };
  }
  if (e.event === 'thread') return { ...r, seen, thread: mergeThread(r.thread, [e.data]) };
  if (e.seq <= r.floor) return { ...r, seen };
  switch (e.event) {
    case 'forecast':
      return { ...r, seen, forecast: e.data };
    case 'scores':
      return { ...r, seen, scores: e.data };
    case 'rules':
      return { ...r, seen, rules: e.data };
    case 'clock':
      return { ...r, seen, day: e.data.day };
    case 'case': {
      // A second case (a new bill, the CD, a shortfall after a DONE case) replaces the first. Keep
      // only what already belongs to the new one: its approvals or negotiation may arrive first.
      const next = e.data.case;
      const sameCase = r.case?.id === next.id;
      const negotiation = sameCase || r.negotiation?.caseId === next.id ? r.negotiation : null;
      return {
        ...r,
        seen,
        case: next,
        plan: e.data.plan,
        bill: e.data.bill !== undefined ? e.data.bill : sameCase ? r.bill : null,
        approvals: sameCase ? r.approvals : r.approvals.filter((a) => a.caseId === next.id || next.approvalIds.includes(a.id)),
        call: sameCase || (negotiation && r.call?.negotiationId === negotiation.id) ? r.call : null,
        negotiation,
      };
    }
    case 'approval':
      return { ...r, seen, approvals: upsert(r.approvals, e.data) };
    case 'call':
      // Only the case's own call: an inbound call (no negotiation) or an old case's call stays out of the panel.
      if (!e.data.negotiationId || (r.negotiation && e.data.negotiationId !== r.negotiation.id)) return { ...r, seen };
      return { ...r, seen, call: e.data };
    case 'negotiation':
      if (r.case && e.data.caseId !== r.case.id) return { ...r, seen };
      return { ...r, seen, negotiation: e.data };
    case 'arena':
      return { ...r, seen, arenaProgress: e.data };
    case 'reset':
      return { ...r, seen };
  }
}

// ---------------------------------------------------------------------------
// Derivation: Raw + UI -> DashboardState
// ---------------------------------------------------------------------------

const initialUi: UiState = {
  tab: 'home',
  range: 14,
  presenter: false,
  statOpen: null,
  whatIfOpen: false,
  whatIf: { car: false, late: false, card: false, cd: false },
  cdDismissed: false,
};

const NO_WHAT_IF: WhatIfToggles = { car: false, late: false, card: false, cd: false };
const WHAT_IF_FEE: number = 2000; // the mockup's example fee: $20

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

const whole = formatWholeDollars;

/** Lowest intraday balance in the first `n` days of a forecast. */
function lowestIn(f: Forecast, n: number): Lowest {
  const days = f.days.slice(0, n);
  let lo = days[0];
  for (const d of days) if (lo && d.intradayLow < lo.intradayLow) lo = d;
  return lo ? { amount: lo.intradayLow, day: lo.day } : { amount: f.lowest.amount, day: f.lowest.day };
}

function daysBelowZero(f: Forecast, n: number): number {
  return f.days.slice(0, n).filter((d) => d.close < 0).length;
}

function forecastWith(raw: Raw, changes: Change[]): Forecast {
  return engine.forecast(raw.household, { fromDay: raw.day, days: 60, changes });
}

function itemLabel(raw: Raw, itemId: string, fallback: string): string {
  return raw.household.scheduled.find((s) => s.id === itemId)?.label ?? fallback;
}

function caseApprovals(raw: Raw): Approval[] {
  const c = raw.case;
  if (!c) return [];
  return raw.approvals.filter((a) => a.caseId === c.id || c.approvalIds.includes(a.id));
}

function pendingApproval(raw: Raw, kind: Approval['kind']): Approval | undefined {
  return caseApprovals(raw).find((a) => a.kind === kind && a.status === 'pending');
}

/** The offer the deal was made on: the last one read back and passed by the engine (the server's own rule). */
function agreedOffer(neg: Negotiation | null): Offer | null {
  if (!neg) return null;
  const passed = (o: Offer) => neg.checks?.some((k) => k.offerId === o.id && k.pass) ?? false;
  return [...neg.offers].reverse().find((o) => o.readBackConfirmed && passed(o)) ?? null;
}

/** The car payment move this case committed, if it did (the deal was approved and confirmed). */
function committedMove(c: Case): Extract<Change, { type: 'move_item' }> | null {
  return (c.acceptedChanges ?? []).find((x): x is Extract<Change, { type: 'move_item' }> => x.type === 'move_item') ?? null;
}

/** The deal approval ran out: the lender was asked to hold the offer and nothing changed. */
function isHeld(raw: Raw): boolean {
  const c = raw.case;
  if (!c || !raw.negotiation || committedMove(c)) return false;
  return c.state === 'HOLD_REQUESTED' || raw.negotiation.outcome === 'approval_timeout' || caseApprovals(raw).some((a) => a.kind === 'deal' && a.status === 'timeout');
}

const HELD_TEXT = 'No answer from Yoshua, so the lender is holding the offer';

/** The offer being discussed: the pending one, else the latest. */
function currentOffer(neg: Negotiation | null): Offer | null {
  if (!neg || neg.offers.length === 0) return null;
  return neg.offers.find((o) => o.id === neg.pendingOfferId) ?? neg.offers[neg.offers.length - 1] ?? null;
}

function optionTitle(raw: Raw, o: Option): { title: string; detail: string } {
  const t = o.tradeoffs;
  switch (o.id) {
    case 'move_payment': {
      const mv = o.changes.find((c) => c.type === 'move_item');
      const label = mv && mv.type === 'move_item' ? itemLabel(raw, mv.itemId, 'car payment') : 'car payment';
      const toDay = mv && mv.type === 'move_item' ? mv.toDay : raw.day;
      const detail =
        o.lowest.amount >= raw.rules.checkingFloor
          ? `Stays above ${whole(raw.rules.checkingFloor)}. Fee up to ${whole(raw.rules.feeLimit)}.`
          : `Lowest ${formatMoney(o.lowest.amount)}. Fee up to ${whole(raw.rules.feeLimit)}.`;
      return { title: `Move your ${label.toLowerCase()} to ${weekdayOf(toDay)}`, detail };
    }
    case 'card':
      return { title: 'Put it on your card', detail: `About ${whole(t.monthlyInterest ?? 0)}/mo interest` };
    case 'savings': {
      const tr = o.changes.find((c) => c.type === 'transfer');
      const amount = tr && tr.type === 'transfer' ? tr.amount : 0;
      const below = o.violations.includes('BELOW_SAVINGS_FLOOR');
      return {
        title: `Use ${whole(amount)} of savings`,
        detail: `${below ? 'Below' : 'Above'} your ${whole(raw.rules.savingsFloor)} floor`,
      };
    }
    case 'cd_renew':
      return { title: 'Renew the CD', detail: `Earns about ${whole(t.yearlyInterestEarned ?? 0)} a year` };
    case 'cd_payoff_card': {
      const pay = o.changes.find((c) => c.type === 'pay_down');
      const tr = o.changes.find((c) => c.type === 'transfer');
      const payoff = pay && pay.type === 'pay_down' ? pay.amount : 0;
      const toSavings = tr && tr.type === 'transfer' ? tr.amount : 0;
      const em =
        t.emergencyMonthsBefore !== null && t.emergencyMonthsAfter !== null
          ? `, and your emergency fund goes from ${formatOneDecimal(t.emergencyMonthsBefore)} to ${formatOneDecimal(t.emergencyMonthsAfter)} months`
          : '';
      return {
        title: 'Pay off your card, save the rest',
        detail: `${whole(payoff)} to the card, ${whole(toSavings)} to savings. Saves about ${whole(t.yearlyInterestSaved ?? 0)} a year${em}.`,
      };
    }
  }
}

/** Options as shown to Yoshua: the approval's optionIds order, else the case's own order. */
function orderedOptions(raw: Raw, approval: Approval | undefined): Option[] {
  const options = raw.case?.options ?? [];
  const ids = approval?.optionIds;
  if (!ids) return options;
  const out: Option[] = [];
  for (const id of ids) {
    const o = options.find((x) => x.id === id);
    if (o) out.push(o);
  }
  return out;
}

function billCondition(raw: Raw): string {
  const b = raw.bill;
  if (!b) {
    // A shortfall has no bill: the dip is already in the plan (a late paycheck, say).
    if (raw.case?.kind === 'shortfall') return 'If nothing changes.';
    return raw.case?.title ? `If you pay ${raw.case.title}.` : '';
  }
  const noun = (b.description || 'bill').trim().split(/\s+/).pop()?.toLowerCase() || 'bill';
  const when = b.dueDay === null || b.dueDay <= raw.day ? 'today' : formatDayRelative(b.dueDay, raw.day);
  return `If you pay the ${formatMoney(b.amount)} ${noun} ${when}.`;
}

/** What the held deal was: the offer the lender is holding, in the lender's own terms. */
function heldView(raw: Raw): PanelView {
  const offer = currentOffer(raw.negotiation);
  const day0 = raw.household.day0Date;
  const when = offer ? formatDate(offer.newDay, day0) : 'the offer';
  const rows = offer
    ? [
        { label: itemLabel(raw, offer.itemId, 'Payment'), value: formatDate(offer.newDay, day0) },
        { label: 'Fee', value: formatMoney(offer.fee) },
      ]
    : [];
  return {
    step: 'held',
    variant: 'no_answer',
    title: offer ? `The lender is holding ${when}` : 'The lender is holding the offer',
    detail: 'PacePay didn’t hear back in time, so it asked the lender to hold the offer and ended the call. Text PacePay when you’re ready to go again.',
    offer: rows,
  };
}

/** The bill the readers weren't sure about, with the reason PacePay is asking. */
function billConfirmView(raw: Raw, b: Bill): PanelView {
  const cc = b.crossCheck;
  const disagree = cc && !cc.agrees;
  const note = disagree ? 'The two readers saw different numbers.' : b.confidence < 0.8 ? 'The photo was hard to read.' : '';
  const due = b.dueDay === null ? 'No date on it' : b.dueDay <= raw.day ? 'Today' : formatDate(b.dueDay, raw.household.day0Date);
  return { step: 'bill_confirm', merchant: b.merchant, amount: b.amount, due, note, approvalId: pendingApproval(raw, 'bill_confirm')?.id };
}

function derivePanelBase(raw: Raw, ui: UiState, now: number): PanelView {
  const c = raw.case;
  if (!c) return { step: 'idle' };

  const choice = pendingApproval(raw, 'option_choice');
  const limits = pendingApproval(raw, 'call_limits');
  const deal = pendingApproval(raw, 'deal');

  if (deal) {
    const neg = raw.negotiation;
    const offer = currentOffer(neg);
    const check = neg?.checks?.find((k) => k.offerId === offer?.id);
    const item = neg?.itemId ?? offer?.itemId ?? ITEM_IDS.carPayment;
    const before = safe(() => {
      const applied = engine.applyChanges(raw.household, raw.acceptedChanges);
      const sched = applied.scheduled.find((s) => s.id === item);
      return sched ? (engine.postingDays(applied, sched, raw.day + HORIZON_DAYS)[0] ?? null) : null;
    }, null as number | null);
    const rows = [
      { label: 'Payment', before: before === null ? '' : formatDate(before), after: offer ? formatDate(offer.newDay) : '' },
      { label: 'Fee', before: formatMoney(0), after: formatMoney(offer?.fee ?? 0) },
      { label: 'Lowest', before: formatMoney(lowestIn(raw.forecast, 14).amount), after: check ? formatMoney(check.lowest.amount) : '' },
    ];
    const secondsLeft = deal.timeoutMs
      ? Math.max(0, Math.ceil((Date.parse(deal.requestedAt) + deal.timeoutMs - now) / 1000))
      : undefined;
    return { step: 'approve', rows, approvalId: deal.id, secondsLeft };
  }

  // A bill PacePay is unsure about: asks before it builds options (only while no option is pending).
  const billCheck = pendingApproval(raw, 'bill_confirm');
  if (billCheck && raw.bill && !choice) return billConfirmView(raw, raw.bill);

  // Limits: the pending call_limits approval, and also while the call plan is being written
  // (PREPARING_CALL) or the answer is on its way, so the panel goes Heads up -> Limits -> Call.
  const answered = caseApprovals(raw).find((a) => a.kind === 'call_limits' && a.status !== 'pending');
  const said = !answered ? null : answered.status === 'approved' || answered.answer === 'yes' ? 'yes' : 'no';
  if (limits || c.state === 'PREPARING_CALL' || (c.state === 'AWAITING_LIMITS' && !said)) {
    const neg = raw.negotiation;
    const mv = c.options?.find((o) => o.id === 'move_payment')?.changes.find((x) => x.type === 'move_item');
    const askFor = neg?.callPlan.targetDay ?? (mv && mv.type === 'move_item' ? mv.toDay : raw.day);
    return {
      step: 'limits',
      askFor,
      maxFee: neg?.callPlan.feeLimit ?? raw.rules.feeLimit,
      newCredit: 'None',
      approvalId: limits?.id,
    };
  }
  if (c.state === 'AWAITING_LIMITS' && said === 'yes') return { step: 'call' };

  if (choice && c.kind === 'cd_maturing') {
    if (ui.cdDismissed) return { step: 'idle' };
    const ordered = orderedOptions(raw, choice);
    const best = ordered[0];
    const other = ordered[1];
    const cd = raw.household.accounts.find((a) => a.id === ACCOUNT_IDS.cd);
    if (!best) return { step: 'idle' };
    const bt = optionTitle(raw, best);
    const ot = other ? optionTitle(raw, other) : null;
    return {
      step: 'cd_alert',
      cdAmount: cd?.balance ?? 0,
      maturesOn: cd?.maturesOn ?? raw.day,
      best: { title: bt.title, detail: bt.detail },
      other: other && ot ? { optionId: other.id, title: ot.title, detail: ot.detail } : { optionId: 'cd_renew', title: 'Renew the CD', detail: '' },
      approvalId: choice.id,
    };
  }

  if (choice) {
    const ordered = orderedOptions(raw, choice);
    const best = ordered[0];
    if (!best) return { step: 'idle' };
    const bt = optionTitle(raw, best);
    return {
      step: 'heads_up',
      lowest: lowestIn(raw.forecast, 14),
      condition: billCondition(raw),
      best: { optionId: best.id, title: bt.title, detail: bt.detail, cta: best.id === 'move_payment' ? 'Ask my lender' : 'Do this one' },
      others: ordered.slice(1).map((o): OptionRow => ({ optionId: o.id, ...optionTitle(raw, o) })),
      approvalId: choice.id,
    };
  }

  const neg = raw.negotiation;
  // Held: no answer to the deal in time. Nothing changed; the panel says so, and derive() also
  // puts HELD_TEXT on the chart's status line.
  if (isHeld(raw)) return heldView(raw);

  const inNegotiation: Case['state'][] = ['REVIEWING', 'CALLING', 'NEGOTIATING', 'AWAITING_APPROVAL', 'CONFIRMING', 'TEXT_NEGOTIATION'];
  if (inNegotiation.includes(c.state)) return { step: 'call' };

  if (c.state === 'SUMMARIZING' || c.state === 'DONE' || c.state === 'ADVISED') {
    if (c.kind === 'cd_maturing') return { step: 'idle' };
    // Done only for what was committed: the confirmed move, shown with the offer that passed (not
    // an earlier read-back the engine rejected). A declined or failed negotiation changed nothing.
    const moved = committedMove(c);
    const offer = agreedOffer(neg);
    const lowest = lowestIn(raw.forecast, 14);
    if (neg && moved) {
      const fee = offer?.fee ?? (c.acceptedChanges ?? []).reduce((sum, x) => sum + (x.type === 'add_fee' ? x.amount : 0), 0);
      const results = [
        { label: itemLabel(raw, offer?.itemId ?? moved.itemId, 'Payment'), value: formatDate(offer?.newDay ?? moved.toDay) },
        { label: 'Fee', value: formatMoney(fee) },
        { label: 'Lowest', value: formatMoney(lowest.amount) },
      ];
      const reference = neg.referenceNumber ?? raw.call?.referenceNumber;
      return { step: 'done', coveredThrough: raw.day + HORIZON_DAYS, results, reference };
    }
    if (c.chosenOption && !neg) {
      const opt = c.options?.find((o) => o.id === c.chosenOption);
      const lowRow = { label: 'Lowest', value: formatMoney(lowest.amount) };
      const results = opt ? [{ label: 'Chosen', value: optionTitle(raw, opt).title }, lowRow] : [lowRow];
      return { step: 'done', coveredThrough: raw.day + HORIZON_DAYS, results };
    }
  }
  return { step: 'idle' };
}

function deriveCall(raw: Raw): CallView | null {
  const c = raw.case;
  const neg = raw.negotiation;
  if (!c || (!raw.call && !neg)) return null;
  const textMode = neg?.channel === 'text' || c.state === 'TEXT_NEGOTIATION' || raw.call?.status === 'failed';
  const negLines = neg?.transcript ?? [];
  const callLines = raw.call?.transcript ?? [];
  const lines = !textMode && callLines.length > 0 ? callLines : negLines.length > 0 ? negLines : callLines;
  const offers: OfferRow[] = [];
  for (const o of neg?.offers ?? []) {
    const check = neg?.checks?.find((k) => k.offerId === o.id);
    if (!check) continue;
    offers.push({
      offerId: o.id,
      newDay: o.newDay,
      fee: o.fee,
      label: `${formatDate(o.newDay)} · ${o.fee === 0 ? 'no fee' : `${formatMoney(o.fee)} fee`}`,
      verdict: offerVerdict(check),
      pass: check.pass,
    });
  }
  return {
    call: raw.call,
    negotiation: neg,
    textMode,
    elapsedSec: 0,
    transcriptTail: lines.slice(-4),
    offers,
    canAdvance: false,
    atEnd: false,
    lenderNext: null,
  };
}

function elapsed(call: Call | null, now: number): number {
  if (!call) return 0;
  const end = call.endedAt ? Date.parse(call.endedAt) : now;
  return Math.max(0, Math.round((end - Date.parse(call.startedAt)) / 1000));
}

function lineChart(f: Forecast, ghost: ChartView['ghost'], floor: number, range: number, mode: ChartView['mode'], prefix: string, suffix = ''): ChartView {
  const lowest = lowestIn(f, range);
  const text = statusLineText({ lowest });
  return {
    line: f,
    ghost,
    floor,
    status: `${prefix}${prefix ? text.charAt(0).toLowerCase() + text.slice(1) : text}${suffix}`,
    lowest,
    mode,
  };
}

/** The "Before" forecast: the plan without the moved payment and fee the case just committed. */
function beforeForecast(raw: Raw): Forecast | null {
  const committed = raw.case?.acceptedChanges ?? [];
  const drop = new Set(committed.filter((c) => c.type === 'move_item' || c.type === 'add_fee').map((c) => JSON.stringify(c)));
  if (drop.size === 0) return null;
  const changes = raw.acceptedChanges.filter((c) => !drop.has(JSON.stringify(c)));
  return safe(() => forecastWith(raw, changes), null as Forecast | null);
}

interface WhatIfPlan {
  rows: WhatIfRow[];
  changes: Change[];
  /** The CD payoff option: the CD case's own when one is open (so the numbers match the CD alert), else the engine's. */
  cdOption: Option | null;
}

function buildWhatIf(raw: Raw, t: WhatIfToggles, panelStep: PanelView['step']): WhatIfPlan {
  const h = raw.household;
  const base = raw.acceptedChanges;
  const rows: WhatIfRow[] = [];
  let changes = [...base];

  // Move the car payment (gone once a deal is in)
  const alreadyMoved = base.some((c) => c.type === 'move_item' && c.itemId === ITEM_IDS.carPayment);
  const carTarget = safe(() => engine.planCallTargets(h, ITEM_IDS.carPayment, { baseChanges: base, fromDay: raw.day }), null);
  const carDay = carTarget && carTarget.targetDay >= 0 ? carTarget.targetDay : null;
  const carFee = Math.min(WHAT_IF_FEE, raw.rules.feeLimit);
  rows.push({
    key: 'car',
    label: `Move the car payment${carDay !== null ? ` to ${weekdayOf(carDay)}` : ''}`,
    detail: carDay !== null ? `${formatDate(carDay)} with a ${formatMoney(carFee)} fee` : '',
    checked: t.car,
    available: carDay !== null && !alreadyMoved && panelStep !== 'done',
  });

  // Paycheck lands Monday
  const pay = safe(() => {
    const applied = engine.applyChanges(h, base);
    const sched = applied.scheduled.find((s) => s.id === ITEM_IDS.paycheck);
    const first = sched ? (engine.postingDays(applied, sched, raw.day + HORIZON_DAYS).find((d) => d >= raw.day) ?? null) : null;
    if (first === null) return null;
    let mon = first + 1;
    while (weekdayOf(mon) !== 'Mon') mon += 1;
    return { first, mon };
  }, null as { first: number; mon: number } | null);
  rows.push({
    key: 'late',
    label: `Paycheck lands ${pay ? weekdayOf(pay.mon) : 'Mon'}, not ${pay ? weekdayOf(pay.first) : 'Thu'}`,
    detail: pay ? `${formatDate(pay.mon)} instead of ${formatDate(pay.first)}` : '',
    checked: t.late,
    available: !!pay,
  });

  // Put the repair on the card
  const bill = raw.bill;
  const billInPlan = !!bill && base.some((c) => c.type === 'add_item' && c.item.id === billItemId(bill.id));
  const cardApr = h.accounts.find((a) => a.id === ACCOUNT_IDS.creditCard)?.apr ?? 0;
  const interest = bill ? (raw.case?.options?.find((o) => o.id === 'card')?.tradeoffs.monthlyInterest ?? engine.monthlyInterest(bill.amount, cardApr)) : 0;
  rows.push({
    key: 'card',
    label: 'Put the repair on your card',
    detail: `About ${whole(interest)}/mo interest`,
    checked: t.card,
    available: billInPlan,
  });

  // CD payoff
  const cd = h.accounts.find((a) => a.id === ACCOUNT_IDS.cd);
  const cdOption =
    (raw.case?.kind === 'cd_maturing' ? raw.case.options?.find((o) => o.id === 'cd_payoff_card') : undefined) ??
    safe(() => (cd ? (engine.cdOptions(h, cd.id, { fromDay: raw.day }).find((o) => o.id === 'cd_payoff_card') ?? null) : null), null as Option | null);
  const cdChanges = cdOption?.changes ?? [];
  rows.push({
    key: 'cd',
    label: 'Use the CD to pay off your card',
    detail: cd?.maturesOn !== undefined ? `When it matures ${formatDate(cd.maturesOn)}` : '',
    checked: t.cd,
    available: cdChanges.length > 0,
  });

  const on = (k: WhatIfKey) => t[k] && rows.find((r) => r.key === k)?.available;
  if (on('card') && bill) {
    changes = changes.filter((c) => !(c.type === 'add_item' && c.item.id === billItemId(bill.id)));
    changes.push({ type: 'charge_card', accountId: ACCOUNT_IDS.creditCard, amount: bill.amount, day: bill.dueDay ?? raw.day, label: bill.merchant });
  }
  if (on('car') && carDay !== null) changes.push(...safe(() => engine.offerChanges(h, { itemId: ITEM_IDS.carPayment, newDay: carDay, fee: carFee }), [] as Change[]));
  if (on('late') && pay) changes.push({ type: 'move_item', itemId: ITEM_IDS.paycheck, toDay: pay.mon });
  if (on('cd')) changes.push(...cdChanges);
  return { rows, changes, cdOption };
}

function deriveWhatIf(raw: Raw, ui: UiState, plan: WhatIfPlan, whatIfForecast: Forecast): WhatIfView {
  const n = ui.range;
  const t = ui.whatIf;
  const anyChecking = t.car || t.late || t.card;
  const nowLow = lowestIn(raw.forecast, n);
  const wiLow = lowestIn(whatIfForecast, n);
  const b0 = daysBelowZero(raw.forecast, n);
  const b1 = daysBelowZero(whatIfForecast, n);
  const extra: string[] = [];
  const sim = safe(() => engine.simulate(raw.household, plan.changes, { fromDay: raw.day }), null);
  const score = (list: HealthScore[] | undefined, key: HealthScore['key']) => list?.find((s) => s.key === key);
  if (anyChecking && (b0 || b1)) extra.push(`Days below $0: ${b0} → ${b1}`);
  if (t.card) {
    const a = score(raw.scores, 'credit_use');
    const b = score(sim?.scores, 'credit_use');
    const interest = plan.rows.find((r) => r.key === 'card')?.detail.replace(/^About /, 'about ') ?? '';
    if (a && b) extra.push(`Card use: ${formatPercent(a.value)} → ${formatPercent(b.value)}${interest ? `, ${interest}` : ''}`);
  }
  if (t.cd && plan.cdOption) {
    // From the CD option's own tradeoffs, as the CD alert says it. Scores at today would miss the
    // money landing in savings when the CD matures.
    const { emergencyMonthsBefore: a, emergencyMonthsAfter: b, yearlyInterestSaved: saved } = plan.cdOption.tradeoffs;
    if (a !== null && b !== null) extra.push(`Emergency fund: ${formatOneDecimal(a)} → ${formatOneDecimal(b)} months${saved ? `, about ${whole(saved)} a year saved` : ''}`);
  }
  if (!t.car && !t.late && !t.card && !t.cd) extra.push('Pick a change below to see what happens.');
  return {
    lowestNow: nowLow,
    lowestWhatIf: wiLow,
    daysBelowZeroNow: b0,
    daysBelowZeroWhatIf: b1,
    extraLines: extra,
    rows: plan.rows,
  };
}

function householdSummary(raw: Raw): HouseholdSummary {
  const accounts = CATEGORIES.flatMap((c) => raw.byCategory[c] ?? []);
  const checking = raw.household.accounts.find((a) => a.id === ACCOUNT_IDS.checking);
  return {
    personName: 'Yoshua',
    day0Date: raw.household.day0Date,
    checkingAccountId: ACCOUNT_IDS.checking,
    checkingBalance: raw.forecast.days[0]?.open ?? checking?.balance ?? 0,
    netWorth: raw.netWorth,
    accountCount: accounts.length,
    accounts,
    byCategory: raw.byCategory,
    monthlyEssentials: raw.household.monthlyEssentials.reduce((sum, m) => sum + m.amount, 0),
  };
}

function derive(raw: Raw, ui: UiState, now: number, notice: string | null, readOnly: boolean): DashboardState {
  const basePanel = derivePanelBase(raw, ui, now);
  const inCall = basePanel.step === 'call' || basePanel.step === 'approve';
  const whatIfOn = ui.whatIfOpen && !inCall;
  const range = ui.range;
  const floor = raw.rules.checkingFloor;

  let panel = basePanel;
  let chart: ChartView = lineChart(raw.forecast, null, floor, range, 'plan', '');
  let whatIf: WhatIfView | null = null;

  if (whatIfOn) {
    panel = { step: 'what_if' };
    const plan = buildWhatIf(raw, ui.whatIf, basePanel.step);
    const f = safe(() => forecastWith(raw, plan.changes), raw.forecast);
    const any = ui.whatIf.car || ui.whatIf.late || ui.whatIf.card;
    chart = lineChart(f, any ? { forecast: raw.forecast, label: 'Current plan' } : null, floor, range, 'what_if', 'What if: ');
    whatIf = deriveWhatIf(raw, ui, plan, f);
  } else if (isHeld(raw)) {
    chart = { ...chart, status: HELD_TEXT };
  } else if (basePanel.step === 'done') {
    const before = beforeForecast(raw);
    chart = lineChart(raw.forecast, before ? { forecast: before, label: 'Before' } : null, floor, range, 'done', '', ' · on track');
  } else if (inCall) {
    const offer = currentOffer(raw.negotiation);
    if (offer) {
      const f = safe(
        () => forecastWith(raw, [...raw.acceptedChanges, ...engine.offerChanges(raw.household, { itemId: offer.itemId, newDay: offer.newDay, fee: offer.fee })]),
        null as Forecast | null,
      );
      if (f) chart = lineChart(f, { forecast: raw.forecast, label: 'Before' }, floor, range, 'offer', 'This offer: ');
    }
  }

  const call = deriveCall(raw);
  if (call) call.elapsedSec = elapsed(raw.call, now);

  return {
    mode: 'live',
    connection: raw.connection,
    day: raw.day,
    ui: { ...ui, whatIfOpen: whatIfOn },
    household: householdSummary(raw),
    rules: raw.rules,
    forecast: raw.forecast,
    acceptedChanges: raw.acceptedChanges,
    scores: raw.scores,
    chart,
    panel,
    current: raw.case ? { case: raw.case, plan: raw.plan, approvals: caseApprovals(raw), bill: raw.bill } : null,
    // Only during the call, as in demo mode (the chart's What if button hides while there is one).
    call: inCall ? call : null,
    whatIf,
    thread: raw.thread,
    activity: raw.activity,
    arena: raw.arena,
    arenaProgress: raw.arenaProgress,
    notice: notice ?? (raw.connection === 'reconnecting' ? 'Reconnecting to the server' : null),
    readOnly,
  };
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export function useLiveDashboard(baseUrl: string | null, readOnly = false): UseDashboard | null {
  const [raw, setRaw] = useState<Raw | null>(null);
  const [ui, setUi] = useState<UiState>(initialUi);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const rawRef = useRef<Raw | null>(null);
  rawRef.current = raw;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Load the snapshot, then follow the stream. Retry the snapshot until it answers.
  useEffect(() => {
    if (!baseUrl) {
      setRaw(null);
      return;
    }
    let cancelled = false;
    let closeStream: (() => void) | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async (reset = false): Promise<void> => {
      try {
        const snap = await apiGet<SnapshotResponse>(API.snapshot);
        if (cancelled) return;
        setRaw((prev) => {
          if (prev && !reset && snap.lastSeq < prev.seen) {
            // The snapshot is older than events we already applied; ask again shortly.
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => void refresh(), 400);
            return prev;
          }
          const next = fromSnapshot(snap, prev);
          if (reset) {
            next.activity = [];
            next.activityFloor = snap.lastSeq;
            next.thread = snap.thread;
          }
          return next;
        });
        if (reset) setUi((u) => ({ ...u, whatIfOpen: false, whatIf: NO_WHAT_IF, statOpen: null, cdDismissed: false }));
      } catch {
        // Keep what we have; the stream status line shows the connection.
      }
    };
    const scheduleRefresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void refresh(), 250);
    };

    const boot = async (): Promise<void> => {
      try {
        const snap = await apiGet<SnapshotResponse>(API.snapshot);
        if (cancelled) return;
        setRaw(fromSnapshot(snap, null));
        // lastSeq 0 replays the whole buffer, which is how the activity log backfills.
        closeStream = openEventStream({
          baseUrl,
          lastSeq: 0,
          onStatus: (status) => {
            setRaw((r) => (r ? { ...r, connection: status } : r));
            if (status === 'open') scheduleRefresh();
          },
          onEvent: (e) => {
            if (e.event === 'reset') {
              if (e.seq > (rawRef.current?.floor ?? 0)) void refresh(true);
              return;
            }
            setRaw((r) => (r ? applyEvent(r, e) : r));
            if (e.event === 'case' || e.event === 'forecast') scheduleRefresh();
            if (e.event === 'arena' && e.data.done >= e.data.total) {
              apiGet<ArenaResults>(API.arena)
                .then((arena) => !cancelled && setRaw((r) => (r ? { ...r, arena } : r)))
                .catch(() => {});
            }
          },
        });
      } catch {
        if (!cancelled) retry = setTimeout(boot, 3000);
      }
    };
    void boot();

    return () => {
      cancelled = true;
      clearTimeout(retry);
      clearTimeout(refreshTimer);
      closeStream?.();
    };
  }, [baseUrl]);

  // A one-second tick, only while a call or an approval countdown is on screen.
  const ticking = raw?.case ? ['CALLING', 'NEGOTIATING', 'AWAITING_APPROVAL', 'TEXT_NEGOTIATION', 'HOLD_REQUESTED'].includes(raw.case.state) : false;
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  const state = useMemo(() => (raw ? derive(raw, ui, now, notice, readOnly) : null), [raw, ui, now, notice, readOnly]);

  const actions = useMemo<Actions>(() => {
    const flash = (message: string) => {
      setNotice(message);
      clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(null), 5000);
    };
    const run = async (fn: () => Promise<unknown>, failure: string) => {
      try {
        await fn();
      } catch (e) {
        flash(e instanceof ServerError ? e.message : failure);
      }
    };
    const patchUi = (patch: Partial<UiState>) => setUi((u) => ({ ...u, ...patch }));
    const current = () => rawRef.current;
    const pending = (kind: Approval['kind']) => {
      const r = current();
      return r ? pendingApproval(r, kind) : undefined;
    };
    const answer = (approval: Approval | undefined, text: string) => {
      if (!approval) return;
      // Optimistic: the buttons go away at once; the approval event confirms.
      setRaw((r) => (r ? { ...r, approvals: upsert(r.approvals, { ...approval, status: 'answered', answer: text }) } : r));
      return run(() => apiPost(API.approval(approval.id), { answer: text }), 'Could not send that answer');
    };

    const base: Actions = {
      setTab: (tab) => patchUi({ tab }),
      setRange: (range: ChartRange) => patchUi({ range }),
      togglePresenter: () => setUi((u) => ({ ...u, presenter: !u.presenter })),
      toggleStat: (key) => setUi((u) => ({ ...u, statOpen: u.statOpen === key ? null : key })),

      pickOption: (optionId: OptionId) => {
        const a = pending('option_choice');
        const idx = a?.optionIds?.indexOf(optionId) ?? -1;
        if (a && idx >= 0) void answer(a, String(idx + 1));
      },
      approveLimits: () => {
        const a = pending('call_limits');
        if (a) void answer(a, 'yes');
        else flash('One moment, PacePay is still writing the call plan');
      },
      startCall: () => {},
      nextLine: () => {},
      endCall: () => flash('Only the server can hang up. It ends the call when the negotiation finishes.'),
      failCall: () => void run(() => apiPost(API.demo.failCall), 'Could not switch to text'),
      lenderSays: (text) => {
        const id = current()?.negotiation?.id;
        if (id && text.trim()) void run(() => apiPost(API.lenderSays(id), { text }), 'Could not send that to the negotiator');
      },
      approveDeal: () => void answer(pending('deal'), 'yes'),
      confirmBill: () => void answer(pending('bill_confirm'), 'yes'),
      decline: () => void answer(pending('deal') ?? pending('call_limits'), 'no'),
      openActivity: () => patchUi({ tab: 'activity' }),
      compareCdInWhatIf: () => setUi((u) => ({ ...u, whatIfOpen: true, whatIf: { ...u.whatIf, cd: true } })),
      dismissCdAlert: () => patchUi({ cdDismissed: true }),

      toggleWhatIf: () => setUi((u) => ({ ...u, whatIfOpen: !u.whatIfOpen, whatIf: u.whatIfOpen ? NO_WHAT_IF : u.whatIf })),
      setWhatIf: (key, on) => setUi((u) => ({ ...u, whatIf: { ...u.whatIf, [key]: on } })),

      skipClock: () => {
        const day = current()?.day ?? 0;
        setUi((u) => ({ ...u, whatIfOpen: false, whatIf: NO_WHAT_IF, statOpen: null, cdDismissed: false, tab: day >= CD_ALERT_DAY ? u.tab : 'home' }));
        void run(async () => {
          try {
            await apiPost(API.demo.clock, { day: day >= CD_ALERT_DAY ? 0 : CD_ALERT_DAY });
          } catch (e) {
            // Going back may not be allowed; a reset also lands on day 0.
            if (day >= CD_ALERT_DAY) await apiPost(API.demo.reset);
            else throw e;
          }
        }, 'Could not move the clock');
      },
      reset: () => {
        setUi((u) => ({ ...u, whatIfOpen: false, whatIf: NO_WHAT_IF, statOpen: null, cdDismissed: false }));
        void run(() => apiPost(API.demo.reset), 'Could not reset the demo');
      },
      injectBillPhoto: () => void run(() => apiPost(API.demo.billPhoto, { fixture: 'brake_quote' }), 'Could not send the bill photo'),

      sendMessage: (text) => {
        if (text.trim()) void run(() => apiPost(API.thread, { text }), 'Could not send that message');
      },
      setRules: (rules) => {
        setRaw((r) => (r ? { ...r, rules } : r));
        void run(() => apiPut(API.rules, rules), 'Could not save your rules');
      },
      togglePause: () => {
        const r = current();
        if (!r) return;
        const rules = { ...r.rules, paused: !r.rules.paused };
        setRaw((x) => (x ? { ...x, rules } : x));
        void run(() => apiPut(API.rules, rules), 'Could not save your rules');
      },
      runArenaLive: () => void run(() => apiPost(API.arenaRun, { count: 3, live: true }), 'Could not start the arena run'),
    };

    // Through the public tunnel the server refuses every write (403 read_only). Rather than let a
    // button fail, each write says why and does nothing; reading, tabs, what-if and Presenter still work.
    const WRITES = [
      'pickOption', 'approveLimits', 'startCall', 'nextLine', 'endCall', 'failCall', 'lenderSays', 'approveDeal', 'decline', 'confirmBill',
      'skipClock', 'reset', 'injectBillPhoto', 'sendMessage', 'setRules', 'togglePause', 'runArenaLive',
    ] as const satisfies readonly (keyof Actions)[];
    const guarded: Actions = { ...base };
    for (const key of WRITES) {
      const fn = base[key] as (...args: never[]) => void;
      (guarded as unknown as Record<string, (...args: never[]) => void>)[key] = (...args: never[]) => {
        if (readOnlyRef.current) flash('View only: actions run from the presenter laptop');
        else fn(...args);
      };
    }
    return guarded;
  }, []);

  if (!baseUrl || !state) return null;
  return { state, actions, mode: 'live' };
}
