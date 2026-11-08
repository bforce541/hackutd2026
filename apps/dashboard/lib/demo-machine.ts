'use client';
/**
 * Demo mode: the mockup's state machine (design/mockup/Main.dc.html, renderVals()) with the real
 * engine in the browser, so pacepay.work works with no server. Owned by: dash-demo.
 *
 * Stages follow the mockup: home (Heads up) -> limits -> call (scripted lender lines; every offer
 * checked by checkOffer, and PacePay's answers follow the verdicts) -> approve -> done, plus the
 * what-if panel (simulate) and the day-11 CD alert (cdOptions). After the deal, the paycheck-late
 * follow-up (v2.md demo script 5-6): "What if my paycheck is late?" gets the engine's answer and an
 * offer to watch, and "My paycheck is going to be late" puts it in the forecast and opens a new
 * Heads up with the call first. The demo ends there: picking an option makes no second call. Each action appends the iMessage
 * thread and Activity log entries the mockup shows; derive (demo-derive.ts) turns the machine into
 * a DashboardState.
 *
 * Every engine call happens inside the hook (initializer, actions, derive), memoized in
 * demo-engine.ts. If the engine throws, the page falls back to the static still in demo-data.ts.
 */
import { useMemo, useState } from 'react';
import {
  ackText,
  callingText,
  cdAlertText,
  cdChoiceReplyText,
  dealApprovalText,
  doneText,
  formatDate,
  formatMoney,
  formatPercent,
  formatWholeDollars,
  limitsText,
  parseReply,
  paycheckDependsText,
  paycheckWatchKeptText,
  reminderText,
  type ActivityType,
  type Message,
  type ModelRole,
  type OptionId,
  type ToolName,
} from '@pacepay/shared';
import type { Actions, DashboardState, UiState, UseDashboard, WhatIfToggles } from './view-model';
import { demoInitialState } from './demo-data';
import { CASE_DAY, REPAIR_AMOUNT, REPAIR_MERCHANT, cdMaturesOn, fixtureRules, itemAmount, runCdOptions, runForecast, type OfferTerms } from './demo-engine';
import {
  CASE_ID,
  DEAL_REFERENCE,
  MINUTE,
  aboutCents,
  dayAt,
  eveningAt,
  parseLenderOffer,
} from './demo-script';
import {
  CAR_PAYMENT_DAY,
  ITEM_LABEL,
  alertMessage,
  caseForecast,
  checkFor,
  checkedLogLine,
  inCall,
  lastOffer,
  lateCase,
  latePaycheck,
  lowestLogLine,
  needsHelp,
  nextCallLine,
  openingLine,
  optionsLogLine,
  pacepayReply,
  paycheckAnswer,
  paycheckIntent,
  planChanges,
  rankedOptions,
  savingsAmount,
  targetDay,
  type CallLine,
  type DemoMachine,
} from './demo-case';
import { derive } from './demo-derive';

const NO_WHAT_IF: WhatIfToggles = { car: false, late: false, card: false, cd: false };
const DAY11 = 11;
const D11 = 'd11-'; // id prefix for entries that belong to the day-11 jump (removed on "Back")
const DEMO_END = 'The demo ends here. A second call is not part of it.';

// ---------------------------------------------------------------------------
// Thread and log helpers (pure: return a new machine)
// ---------------------------------------------------------------------------

/** Move the demo clock forward to `minute` (never back). */
function tick(m: DemoMachine, minute: number): DemoMachine {
  return minute > m.minute ? { ...m, minute } : m;
}

interface LogIn {
  type: ActivityType;
  model?: ModelRole;
  tool?: ToolName;
  title: string;
  at?: string;
  prefix?: string;
}

function log(m: DemoMachine, e: LogIn): DemoMachine {
  const seq = m.seq + 1;
  return {
    ...m,
    seq,
    activity: [
      ...m.activity,
      { id: `${e.prefix ?? ''}a${seq}`, seq, at: e.at ?? eveningAt(m.minute), type: e.type, model: e.model, tool: e.tool, title: e.title, caseId: CASE_ID },
    ],
  };
}

/** Yoshua's own decisions show "Yoshua" in the log (a message.in row with no model). */
const yoshua = (m: DemoMachine, title: string, at?: string) => log(m, { type: 'message.in', title, at });

function msg(m: DemoMachine, direction: Message['direction'], body: { text?: string; imageUrl?: string }, opts: { at?: string; prefix?: string; channel?: Message['channel'] } = {}): DemoMachine {
  const seq = m.seq + 1;
  return {
    ...m,
    seq,
    thread: [...m.thread, { id: `${opts.prefix ?? ''}m${seq}`, direction, channel: opts.channel ?? 'imessage', ...body, at: opts.at ?? eveningAt(m.minute) }],
  };
}

const out = (m: DemoMachine, text: string) => msg(m, 'out', { text });
const reply = (m: DemoMachine, text: string, viaText: boolean) => (viaText ? m : msg(m, 'in', { text }));

// ---------------------------------------------------------------------------
// The opening: the bill photo, the read, the check and the alert
// ---------------------------------------------------------------------------

/** The engine checks the week and PacePay texts the chart and the alert. */
function analyze(m: DemoMachine, firstPlan: boolean): DemoMachine {
  const fc = caseForecast(m);
  if (firstPlan) m = log(m, { type: 'plan.created', model: 'nemotron-ultra', title: 'Wrote a 15-step plan' });
  m = log(m, { type: 'forecast.updated', model: 'engine', tool: 'get_forecast', title: lowestLogLine(fc) });
  if (needsHelp(m)) m = log(m, { type: 'tool.result', model: 'engine', tool: 'simulate', title: optionsLogLine(m) });
  m = tick(m, MINUTE.alert);
  m = msg(m, 'out', { imageUrl: '/demo/week-chart.png' });
  m = out(m, alertMessage(m));
  return log(m, { type: 'message.out', model: 'nemotron-super', tool: 'send_message', title: needsHelp(m) ? 'Texted Yoshua the options and a chart' : 'Texted Yoshua the chart: no problem this month' });
}

function billArrives(m: DemoMachine): DemoMachine {
  m = msg(m, 'in', { imageUrl: '/demo/brake-quote.png', text: 'Photo of the repair quote' });
  m = yoshua(m, 'Sent a photo of a repair quote');
  m = log(m, {
    type: 'tool.result',
    model: 'nemotron-vision',
    tool: 'read_bill',
    title: `Read it: ${formatMoney(m.billAmount)} to ${REPAIR_MERCHANT}, due today`,
  });
  m = out(m, ackText({ merchant: REPAIR_MERCHANT, amount: m.billAmount, dueDay: CASE_DAY, today: CASE_DAY }));
  return analyze(m, true);
}

function freshUi(presenter: boolean): UiState {
  return { tab: 'home', range: 14, presenter, statOpen: null, whatIfOpen: false, whatIf: NO_WHAT_IF, cdDismissed: false };
}

export function initialMachine(keep: Partial<Pick<DemoMachine, 'rules'>> & { presenter?: boolean } = {}): DemoMachine {
  const m: DemoMachine = {
    ui: freshUi(keep.presenter ?? false),
    day: 0,
    rules: keep.rules ?? fixtureRules(),
    billAmount: REPAIR_AMOUNT,
    stage: 'home',
    chosen: null,
    lines: [],
    lenderPos: 0,
    textMode: false,
    deal: null,
    cdOpen: false,
    cdAnswered: false,
    paycheck: 'on_time',
    thread: [],
    activity: [],
    seq: 0,
    minute: MINUTE.photo,
    notice: null,
  };
  return billArrives(m);
}

// ---------------------------------------------------------------------------
// The case flow
// ---------------------------------------------------------------------------

function pickOption(m: DemoMachine, id: OptionId, viaText = false): DemoMachine {
  if (lateOpen(m)) return { ...m, notice: DEMO_END };
  if (m.stage !== 'home' || !needsHelp(m)) return m;
  const ranked = rankedOptions(m);
  const n = ranked.findIndex((o) => o.id === id) + 1;
  const option = ranked[n - 1];
  if (!option) return m;
  m = tick({ ...m, ui: { ...m.ui, whatIfOpen: false, whatIf: NO_WHAT_IF } }, MINUTE.pick);
  m = reply(m, String(n), viaText);

  if (id === 'move_payment') {
    const to = targetDay(m);
    m = yoshua(m, `Picked ${n}: call the lender`);
    m = log(m, { type: 'tool.result', model: 'nemotron-super', tool: 'get_terms', title: "Pulled the auto loan's terms" });
    m = log(m, {
      type: 'step.completed',
      model: 'nemotron-ultra',
      title: `Planned the call: ask for ${formatDate(to)}, ${formatWholeDollars(m.rules.feeLimit)} max in fees`,
    });
    m = out(m, limitsText({ toDay: to, feeLimit: m.rules.feeLimit }));
    m = log(m, { type: 'approval.requested', model: 'code', tool: 'request_approval', title: 'Asked Yoshua to OK the limits' });
    return { ...m, stage: 'limits', chosen: id };
  }

  // The card or savings: Yoshua makes the move at his bank; the plan updates now.
  const done = { ...m, stage: 'done' as const, chosen: id };
  const lowest = caseLowestAfter(done);
  if (id === 'card') {
    const t = option.tradeoffs;
    m = yoshua(m, `Picked ${n}: put it on the card`);
    m = out(
      m,
      `Got it: put the ${formatWholeDollars(m.billAmount)} on your card. About ${formatWholeDollars(t.monthlyInterest ?? 0)}/mo interest, and card use goes from ${formatPercent(t.creditUseBefore ?? 0)} to ${formatPercent(t.creditUseAfter ?? 0)}.`,
    );
  } else {
    const amount = savingsAmount(option);
    m = yoshua(m, `Picked ${n}: use savings`);
    m = out(m, `Got it: move ${formatWholeDollars(amount)} from savings to checking today. Savings goes to ${formatWholeDollars(option.tradeoffs.savingsAfter ?? 0)}.`);
  }
  m = log(m, { type: 'message.out', model: 'nemotron-super', tool: 'send_message', title: 'Texted Yoshua the steps' });
  m = log(m, { type: 'forecast.updated', model: 'engine', title: `Updated the forecast: lowest ${formatMoney(lowest)}` });
  return { ...m, stage: 'done', chosen: id };
}

function caseLowestAfter(m: DemoMachine): number {
  return runForecast(m.rules, planChanges(m), CASE_DAY, 30).lowest.amount;
}

function approveLimits(m: DemoMachine, viaText = false): DemoMachine {
  if (m.stage !== 'limits') return m;
  m = reply(m, 'OK', viaText);
  m = yoshua(m, "OK'd the limits");
  m = log(m, { type: 'review.result', model: 'claude-opus', tool: 'second_opinion', title: 'Second opinion on the call plan: approve' });
  m = out(m, callingText());
  m = tick(m, MINUTE.call);
  m = log(m, { type: 'call.dispatched', model: 'code', tool: 'place_call', title: 'Called the lender' });
  return { ...m, stage: 'call', lines: [openingLine()], lenderPos: 0, textMode: false, deal: null };
}

function offersSoFar(lines: CallLine[]) {
  return lines.filter((l) => l.offer).length;
}

/** Adds a line to the call; a lender offer is checked by the engine and logged. */
function addLine(m: DemoMachine, line: CallLine, scripted: boolean): DemoMachine {
  if (line.offer) {
    m = tick(m, offersSoFar(m.lines) === 0 ? MINUTE.call : MINUTE.offer2);
    m = log(m, { type: 'offer.checked', model: 'engine', tool: 'check_offer', title: checkedLogLine(line.offer, checkFor(m, line.offer)) });
  }
  return { ...m, lines: [...m.lines, line], lenderPos: scripted ? m.lenderPos + 1 : m.lenderPos };
}

function nextLine(m: DemoMachine): DemoMachine {
  if (m.stage !== 'call') return m;
  const next = nextCallLine(m);
  if (next) return addLine(m, next, next.who === 'lender');
  const last = m.lines[m.lines.length - 1];
  return last?.closing === 'deal' ? askYoshua(m) : noDeal(m);
}

function lenderSays(m: DemoMachine, text: string): DemoMachine {
  if (m.stage !== 'call') return m;
  const t = text.trim();
  if (!t) return nextLine(m);
  const offer = parseLenderOffer(t, lastOffer(m.lines), CAR_PAYMENT_DAY);
  const lender: CallLine = { who: 'lender', text: t, ...(offer ? { offer } : {}) };
  m = addLine(m, lender, false);
  return addLine(m, pacepayReply(m, lender), false);
}

function askYoshua(m: DemoMachine): DemoMachine {
  const deal = lastPassing(m);
  if (!deal) return noDeal(m);
  m = tick(m, MINUTE.approve);
  const check = checkFor(m, deal);
  m = out(m, dealApprovalText({ toDay: check.postsOnDay, fee: deal.fee, checkingFloor: m.rules.checkingFloor }));
  m = log(m, {
    type: 'approval.requested',
    model: 'code',
    tool: 'request_approval',
    title: `Asked Yoshua to approve ${formatDate(check.postsOnDay)} for ${formatWholeDollars(deal.fee)}`,
  });
  return { ...m, stage: 'approve', deal };
}

function lastPassing(m: DemoMachine): OfferTerms | null {
  for (let i = m.lines.length - 1; i >= 0; i -= 1) {
    const o = m.lines[i]!.offer;
    if (o && checkFor(m, o).pass) return o;
  }
  return null;
}

function noDeal(m: DemoMachine): DemoMachine {
  m = log(m, { type: 'call.ended', model: 'code', title: 'Ended the call. No deal within your limits' });
  m = out(m, `Your lender couldn't move it within your limits. Nothing changed.`);
  return { ...m, stage: 'home', lines: [], lenderPos: 0, textMode: false, deal: null };
}

function approveDeal(m: DemoMachine, viaText = false): DemoMachine {
  if (m.stage !== 'approve' || !m.deal) return m;
  const deal = m.deal;
  const posts = checkFor(m, deal).postsOnDay;
  m = tick(m, MINUTE.done);
  m = reply(m, 'YES', viaText);
  m = yoshua(m, 'Approved');
  m = log(m, { type: 'offer.confirmed', model: 'code', title: m.textMode ? 'Confirmed the deal by text' : 'Confirmed the deal on the call' });
  m = out(m, doneText({ itemLabel: ITEM_LABEL, toDay: posts, fee: deal.fee, reference: DEAL_REFERENCE }));
  m = log(m, { type: 'message.out', model: 'nemotron-super', tool: 'post_call_summary', title: `Texted the summary, ref ${DEAL_REFERENCE}` });
  const done: DemoMachine = { ...m, stage: 'done', chosen: 'move_payment' };
  m = log(m, { type: 'forecast.updated', model: 'engine', title: `Updated the forecast: lowest ${formatMoney(caseLowestAfter(done))}` });
  m = log(m, { type: 'tool.result', model: 'code', tool: 'schedule_followup', title: `Set a reminder for ${formatDate(posts - 1)}` });
  // Proactive: the new date leans on Thursday's paycheck, so say so and watch for it (NO skips).
  const after: DemoMachine = { ...m, stage: 'done', chosen: 'move_payment' };
  const lp = latePaycheck(after);
  if (!lp || !paycheckAnswer(after)?.watch) return after;
  m = out(after, paycheckDependsText({ payDay: lp.payday }));
  m = log(m, { type: 'message.out', model: 'code', tool: 'send_message', title: `Told Yoshua the new date leans on the ${formatDate(lp.payday)} paycheck` });
  m = log(m, { type: 'tool.result', model: 'code', tool: 'schedule_followup', title: `Set a check for ${formatDate(lp.payday)}, 8:00 PM: has the paycheck landed?` });
  return { ...m, paycheck: 'watching' };
}

function decline(m: DemoMachine, viaText = false): DemoMachine {
  const home = (x: DemoMachine): DemoMachine => ({ ...x, stage: 'home', chosen: null, lines: [], lenderPos: 0, textMode: false, deal: null });
  if (m.stage === 'limits') {
    m = reply(m, 'NO', viaText);
    m = yoshua(m, 'Said no to the limits');
    m = out(m, "OK. I won't call.");
    return home(m);
  }
  if (m.stage === 'call') {
    m = log(m, { type: 'call.ended', model: 'code', title: m.textMode ? 'Stopped the text negotiation. No deal' : 'Ended the call. No deal' });
    return home(m);
  }
  if (m.stage === 'approve') {
    m = reply(m, 'NO', viaText);
    m = yoshua(m, 'Declined the deal');
    m = log(m, { type: 'call.ended', model: 'code', title: 'Told the lender no. Nothing changed' });
    m = out(m, 'OK, I told them no. Nothing changed.');
    return home(m);
  }
  return m;
}

// ---------------------------------------------------------------------------
// The clock: day 11 brings the reminder (if the deal is done) and the CD alert
// ---------------------------------------------------------------------------

function skipClock(m: DemoMachine): DemoMachine {
  if (inCall(m)) return m;
  if (m.day >= DAY11) {
    return {
      ...m,
      day: 0,
      cdOpen: false,
      cdAnswered: false,
      ui: { ...m.ui, whatIfOpen: false, whatIf: NO_WHAT_IF, statOpen: null, cdDismissed: false },
      thread: m.thread.filter((x) => !x.id.startsWith(D11)),
      activity: m.activity.filter((x) => !x.id.startsWith(D11)),
    };
  }

  m = { ...m, day: DAY11, cdOpen: true, cdAnswered: false, ui: { ...m.ui, tab: 'home', whatIfOpen: false, whatIf: NO_WHAT_IF, statOpen: null, cdDismissed: false } };
  const plan = planChanges(m);

  // The night-before reminder (schedule_followup), only for a moved payment.
  if (m.stage === 'done' && m.chosen === 'move_payment' && m.deal && m.paycheck !== 'late') {
    const posts = checkFor(m, m.deal).postsOnDay;
    const at = dayAt(posts - 1, 20, 0);
    const fc = runForecast(m.rules, plan, CASE_DAY, posts + 1);
    const after = fc.days[posts]?.close ?? 0;
    m = msg(m, 'out', { text: reminderText({ itemLabel: ITEM_LABEL, amount: -itemAmount(m.rules, 'auto_payment'), fee: m.deal.fee, when: 'tomorrow', balanceAfter: after }) }, { at, prefix: D11 });
    m = log(m, { type: 'message.out', model: 'code', tool: 'send_message', title: 'Sent the reminder', at, prefix: D11 });
  }

  // The CD alert (cdOptions), unprompted on Wed, Nov 18.
  const at = dayAt(DAY11, 9, 0);
  const opts = runCdOptions(m.rules, plan, DAY11);
  const renew = opts.find((o) => o.id === 'cd_renew');
  const payoff = opts.find((o) => o.id === 'cd_payoff_card');
  if (renew && payoff) {
    const toCard = payoff.changes.find((c) => c.type === 'pay_down');
    const toSavings = payoff.changes.find((c) => c.type === 'transfer');
    const payoffAmt = toCard && toCard.type === 'pay_down' ? toCard.amount : 0;
    const savingsAmt = toSavings && toSavings.type === 'transfer' ? toSavings.amount : 0;
    const maturesOn = toCard && toCard.type === 'pay_down' ? toCard.day : DAY11;
    const saved = aboutCents(payoff.tradeoffs.yearlyInterestSaved ?? 0);
    const earned = aboutCents(renew.tradeoffs.yearlyInterestEarned ?? 0);
    m = log(m, { type: 'forecast.updated', model: 'engine', title: `Daily check: the CD matures ${formatDate(maturesOn)}`, at, prefix: D11 });
    m = log(m, { type: 'plan.created', model: 'nemotron-ultra', title: 'Wrote a 3-step plan for the CD, with no call', at, prefix: D11 });
    m = log(m, {
      type: 'tool.result',
      model: 'engine',
      tool: 'simulate',
      title: `Paying off the card saves about ${formatWholeDollars(saved)} a year. Renewing earns about ${formatWholeDollars(earned)}.`,
      at,
      prefix: D11,
    });
    m = msg(
      m,
      'out',
      {
        text: cdAlertText({
          cdAmount: payoffAmt + savingsAmt,
          maturesOn,
          payoff: payoffAmt,
          toSavings: savingsAmt,
          yearlySaved: saved,
          emergencyBefore: payoff.tradeoffs.emergencyMonthsBefore ?? 0,
          emergencyAfter: payoff.tradeoffs.emergencyMonthsAfter ?? 0,
          renewEarned: earned,
        }),
      },
      { at, prefix: D11 },
    );
    m = log(m, { type: 'message.out', model: 'nemotron-super', tool: 'send_message', title: 'Texted Yoshua the CD options', at, prefix: D11 });
  }
  return m;
}

// ---------------------------------------------------------------------------
// The paycheck-late follow-up (after the deal, on the case day)
// ---------------------------------------------------------------------------

const paycheckReady = (m: DemoMachine) => m.stage === 'done' && m.day === CASE_DAY && m.paycheck !== 'late';
/** The late-paycheck Heads up is showing (its options end the demo). */
const lateOpen = (m: DemoMachine) => m.stage === 'done' && m.paycheck === 'late' && m.day === CASE_DAY;

/** "What if my paycheck is late?": the engine's answer, and PacePay watches for it by default. */
function paycheckWhatIf(m: DemoMachine): DemoMachine {
  const a = paycheckAnswer(m);
  if (!a) return m;
  m = log(m, { type: 'tool.result', model: 'engine', tool: 'simulate', title: a.log });
  m = out(m, a.text);
  m = log(m, { type: 'message.out', model: 'nemotron-super', tool: 'send_message', title: 'Answered Yoshua: what if the paycheck is late' });
  if (!a.watch) return m;
  const pay = latePaycheck(m)?.payday;
  if (pay !== undefined) m = log(m, { type: 'tool.result', model: 'code', tool: 'schedule_followup', title: `Set a check for ${formatDate(pay)}, 8:00 PM: has the paycheck landed?` });
  return { ...m, paycheck: 'watching' };
}

/** "My paycheck is going to be late": it goes in the forecast, and a new Heads up, call first. */
function paycheckIsLate(m: DemoMachine): DemoMachine {
  const lc = lateCase(m);
  m = yoshua(m, 'Said the paycheck will be late');
  if (!lc) {
    const a = paycheckAnswer(m);
    return a ? out(m, a.text) : m;
  }
  m = { ...m, paycheck: 'late', ui: { ...m.ui, whatIfOpen: false, whatIf: NO_WHAT_IF } };
  m = log(m, { type: 'forecast.updated', model: 'engine', tool: 'get_forecast', title: `Moved the paycheck to ${formatDate(lc.late.late)}: lowest ${formatMoney(lc.lowest.amount)} on ${formatDate(lc.lowest.day)}` });
  m = log(m, { type: 'tool.result', model: 'engine', tool: 'simulate', title: lc.optionsLog });
  m = out(m, lc.alert);
  return log(m, { type: 'message.out', model: 'nemotron-super', tool: 'send_message', title: 'Texted Yoshua the options again, the call first' });
}

// ---------------------------------------------------------------------------
// Messages: typed in the coach chat, handled like a text from Yoshua
// ---------------------------------------------------------------------------

function sendMessage(m: DemoMachine, text: string): DemoMachine {
  const t = text.trim();
  if (!t) return m;
  const cdPending = m.day >= DAY11 && m.cdOpen && !m.cdAnswered;
  const lateChoices = lateOpen(m) ? (lateCase(m)?.options.length ?? 0) : 0;
  const choiceCount = m.stage === 'home' && needsHelp(m) ? rankedOptions(m).length : cdPending ? 2 : lateChoices;
  const parsed = parseReply(t, { billUnconfirmed: m.stage === 'home' && m.day === 0, choiceCount });
  const at11 = m.day >= DAY11 ? { at: dayAt(DAY11, 9, 5), prefix: D11 } : {};
  const intent = paycheckReady(m) ? paycheckIntent(t) : null;
  if (intent) m = tick(m, intent === 'what_if' ? MINUTE.paycheckAsk : MINUTE.paycheckLate);
  m = msg(m, 'in', { text: t }, { channel: 'dashboard', ...at11 });

  if (parsed.kind === 'correction') {
    m = { ...m, billAmount: parsed.amount };
    m = yoshua(m, `Corrected the amount to ${formatMoney(parsed.amount)}`);
    m = out(m, ackText({ merchant: REPAIR_MERCHANT, amount: parsed.amount, dueDay: CASE_DAY, today: CASE_DAY }));
    return analyze(m, false);
  }
  if (intent) return intent === 'what_if' ? paycheckWhatIf(m) : paycheckIsLate(m);
  if (m.paycheck === 'watching' && parsed.kind === 'no') {
    m = yoshua(m, 'Said skip the paycheck check');
    m = out(m, "OK, I won't watch for it.");
    return { ...m, paycheck: 'on_time' };
  }
  if (m.paycheck === 'watching' && parsed.kind === 'yes') {
    m = out(m, paycheckWatchKeptText());
    return m;
  }
  if (lateChoices && parsed.kind === 'choice') return { ...m, notice: DEMO_END };
  if (cdPending && parsed.kind === 'choice') {
    const maturesOn = cdMaturesOn(m.rules);
    m = log(m, { type: 'message.in', title: parsed.choice === 1 ? 'Picked 1: pay off the card' : 'Picked 2: renew the CD', ...at11 });
    m = msg(m, 'out', { text: cdChoiceReplyText({ maturesOn }) }, at11);
    return { ...m, cdAnswered: true, ui: { ...m.ui, cdDismissed: true } };
  }
  if (m.stage === 'home' && parsed.kind === 'choice') {
    const option = rankedOptions(m)[parsed.choice - 1];
    if (option) return pickOption(m, option.id, true);
  }
  if (m.stage === 'limits' && parsed.kind === 'yes') return approveLimits(m, true);
  if (m.stage === 'approve' && parsed.kind === 'yes') return approveDeal(m, true);
  if ((m.stage === 'limits' || m.stage === 'approve') && parsed.kind === 'no') return decline(m, true);

  // Anything else: answer with the numbers.
  const st = derive(m);
  m = msg(m, 'out', { text: `Checking has ${formatMoney(st.household.checkingBalance)} today. ${st.chart.status}.` }, at11);
  return log(m, { type: 'message.out', model: 'nemotron-super', tool: 'send_message', title: 'Answered Yoshua with the forecast', ...at11 });
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

function fallbackState(): DashboardState {
  return { ...demoInitialState, notice: 'The money engine failed to load. Showing sample numbers.' };
}

function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    console.error('[demo]', err);
    return fallback;
  }
}

export function useDemoDashboard(): UseDashboard {
  const [machine, setMachine] = useState<DemoMachine | null>(() => safely<DemoMachine | null>(() => initialMachine(), null));
  const state = useMemo(() => (machine ? safely(() => derive(machine), fallbackState()) : fallbackState()), [machine]);

  const actions = useMemo<Actions>(() => {
    const act = (f: (m: DemoMachine) => DemoMachine) => setMachine((m) => (m ? safely(() => f(m), m) : m));
    const ui = (f: (u: UiState, m: DemoMachine) => Partial<UiState>) => act((m) => ({ ...m, ui: { ...m.ui, ...f(m.ui, m) } }));
    return {
      setTab: (tab) => act((m) => ({ ...m, notice: null, ui: { ...m.ui, tab } })),
      setRange: (range) => ui(() => ({ range })),
      togglePresenter: () => ui((u) => ({ presenter: !u.presenter })),
      toggleStat: (key) => ui((u) => ({ statOpen: u.statOpen === key ? null : key })),

      pickOption: (id) => act((m) => pickOption(m, id)),
      approveLimits: () => act((m) => approveLimits(m)),
      startCall: () => act((m) => (m.stage === 'limits' ? approveLimits(m) : m.stage === 'call' && !m.lines.length ? { ...m, lines: [openingLine()] } : m)),
      nextLine: () => act(nextLine),
      endCall: () => act((m) => (m.stage === 'call' ? decline(m) : m)),
      failCall: () =>
        act((m) =>
          m.stage === 'call' && !m.textMode
            ? { ...log(m, { type: 'call.failed', model: 'code', title: 'The call dropped. Switched to text with the same negotiator' }), textMode: true }
            : m,
        ),
      lenderSays: (text) => act((m) => lenderSays(m, text)),
      approveDeal: () => act((m) => approveDeal(m)),
      decline: () => act((m) => decline(m)),
      openActivity: () => ui(() => ({ tab: 'activity' })),
      compareCdInWhatIf: () => ui(() => ({ whatIfOpen: true, whatIf: { ...NO_WHAT_IF, cd: true } })),
      dismissCdAlert: () => ui(() => ({ cdDismissed: true })),

      toggleWhatIf: () => ui((u, m) => (u.whatIfOpen ? { whatIfOpen: false, whatIf: NO_WHAT_IF } : inCall(m) ? {} : { whatIfOpen: true })),
      setWhatIf: (key, on) => ui((u) => ({ whatIf: { ...u.whatIf, [key]: on } })),

      skipClock: () => act(skipClock),
      reset: () => act((m) => initialMachine({ presenter: m.ui.presenter })),
      injectBillPhoto: () => act((m) => ({ ...initialMachine({ presenter: m.ui.presenter, rules: m.rules }), ui: { ...m.ui, whatIfOpen: false, whatIf: NO_WHAT_IF, cdDismissed: false } })),

      sendMessage: (text) => act((m) => sendMessage(m, text)),
      setRules: (rules) =>
        act((m) => log({ ...m, rules: { ...rules, paused: rules.paused ?? m.rules.paused } }, { type: 'tool.result', model: 'code', title: 'Updated your rules' })),
      togglePause: () =>
        act((m) => {
          const paused = !m.rules.paused;
          return log({ ...m, rules: { ...m.rules, paused } }, { type: 'tool.result', model: 'code', title: paused ? 'Paused PacePay' : 'Turned PacePay back on' });
        }),
      runArenaLive: () => act((m) => ({ ...m, notice: 'Live arena runs need the PacePay server. These are the sample results.' })),
    };
  }, []);

  return { state, actions, mode: 'demo' };
}

/** The machine's pure transitions, for scripts that drive demo mode without React. */
export const demoTransitions = { pickOption, approveLimits, nextLine, lenderSays, approveDeal, decline, skipClock, sendMessage };
