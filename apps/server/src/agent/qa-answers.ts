/**
 * Q&A answers built in code (texts and calls): the questions a judge holding Yoshua's phone asks most
 * (balances, scores, bills, paychecks, what-ifs, the case, the lender, what PacePay is) get the money
 * engine's numbers at once, the same every time, with no model to invent or round anything.
 * answerInCode() returns null for anything it does not recognize; qa.ts then asks the model.
 *
 * Every figure comes from the engine on the current plan (store.forecastChanges()), formatted with the
 * shared formatters. Answers are at most three short sentences; the orchestrator adds the re-ask of a
 * pending question after them.
 */
import {
  SCORE_LABELS,
  formatDate,
  formatMoney,
  formatPercent,
  formatWholeDollars,
  normalizeReply,
  termsFromPrompt,
  termsPhrase,
  type Approval,
  type Case,
  type Cents,
  type Change,
  type Day,
  type Forecast,
  type Household,
  type Negotiation,
  type ScoreKey,
} from '@pacepay/shared';
import type { ToolContext } from '../tools/registry';
import { parseDay } from '../tools/simulate';
import { currentForecast, currentNetWorth, currentScores } from '../forecast';

const baseId = (id: string) => id.split(/[@#:]/)[0]!;
const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** Everything one answer may need, computed once. */
class Facts {
  readonly h: Household;
  readonly day0: string;
  readonly today: Day;
  readonly applied: Household;
  readonly now: Map<string, Cents>;
  readonly floor: Cents;
  private f30?: Forecast;
  private f60?: Forecast;
  readonly kase: Case | null;
  readonly pending: Approval[];
  readonly neg?: Negotiation;

  constructor(readonly ctx: ToolContext) {
    this.h = ctx.store.household();
    this.day0 = this.h.day0Date;
    this.today = ctx.clock.today();
    this.applied = ctx.engine.applyChanges(this.h, ctx.store.forecastChanges());
    this.now = ctx.engine.balancesOn(this.applied, this.today);
    this.floor = ctx.store.rules().checkingFloor;
    this.kase = ctx.store.currentCase();
    this.pending = ctx.store.pendingApprovals();
    const negs = ctx.store
      .list('cases')
      .sort((a, b) => (a.openedAt ?? '').localeCompare(b.openedAt ?? ''))
      .map((c) => (c.negotiationId ? ctx.store.getItem('negotiations', c.negotiationId) : undefined))
      .filter((n): n is Negotiation => !!n);
    this.neg = negs.at(-1);
  }
  get forecast30(): Forecast {
    return (this.f30 ??= currentForecast(this.ctx, { days: 30 }));
  }
  get forecast60(): Forecast {
    return (this.f60 ??= currentForecast(this.ctx, { days: 60 }));
  }
  date(d: Day): string {
    return formatDate(d, this.day0);
  }
  acct(id: string) {
    return this.applied.accounts.find((a) => a.id === id);
  }
  bal(id: string): Cents {
    return this.now.get(id) ?? this.acct(id)?.balance ?? 0;
  }
  rules() {
    return this.ctx.store.rules();
  }
  pendingOf(kind: Approval['kind']): Approval | undefined {
    return this.pending.filter((a) => a.kind === kind).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
  }
  get bill() {
    const c = this.kase;
    return c?.billId ? this.ctx.store.getItem('bills', c.billId) : undefined;
  }
  /** The engine-checked deal the lender agreed to (read back and checked), if any. */
  get deal() {
    const n = this.neg;
    if (!n || n.outcome !== 'deal') return undefined;
    return [...n.offers].reverse().find((o) => o.readBackConfirmed && (n.checks ?? []).some((k) => k.offerId === o.id && k.pass));
  }
  get dealRef(): string | undefined {
    const n = this.neg;
    if (!n) return undefined;
    return n.referenceNumber ?? this.ctx.store.list('calls').find((c) => c.negotiationId === n.id && c.referenceNumber)?.referenceNumber;
  }
  itemLabel(itemId: string, label?: string): string {
    const known = this.h.scheduled.find((s) => s.id === baseId(itemId))?.label;
    if (known) return known.toLowerCase();
    // A bill from a photo ("bill:..."), a lender's fee: the forecast item's own label.
    const b = this.bill;
    if (b && itemId.includes(b.id)) return `${b.merchant} bill`;
    return label ? label.replace(/^./, (c) => c.toLowerCase()) : 'payment';
  }
  /** "Fri, Nov 13 for a $20 fee" for the deal. */
  dealTerms(): string | null {
    const d = this.deal;
    if (!d) return null;
    return `${this.date(d.newDay)} ${d.fee ? `for a ${formatMoney(d.fee)} fee` : 'with no fee'}`;
  }
  /** The alert that opened the current case: "Heads up: −$300 on Tue, Nov 10 if you pay ..." */
  alert(c: Case | null = this.kase): { amount: string; day: string; text: string } | null {
    const a = c?.approvalIds.map((id) => this.ctx.store.getItem('approvals', id)).find((x) => x?.kind === 'option_choice');
    const m = a ? /Heads up: (\S+) on (\w{3}, \w{3} \d{1,2})/.exec(a.prompt) : null;
    return m && a ? { amount: m[1]!, day: m[2]!, text: a.prompt } : null;
  }
  /** "your $650 Northside Auto Service bill" */
  billPhrase(): string | null {
    const b = this.bill;
    return b ? `the ${formatMoney(b.amount)} ${b.merchant} bill` : null;
  }
  /** Where checking stands against the minimum, in words. */
  vsFloor(amount: Cents): string {
    if (amount < 0) return 'below $0';
    if (amount < this.floor) return `under your ${formatWholeDollars(this.floor)} minimum`;
    if (amount === this.floor) return `right at your ${formatWholeDollars(this.floor)} minimum`;
    return `above your ${formatWholeDollars(this.floor)} minimum`;
  }
  lowestLine(f: Forecast = this.forecast30): string {
    const low = f.lowest;
    const causes = [...new Set(low.causeItemIds.map((id) => this.itemLabel(id)))];
    return `The lowest checking gets in the next 30 days is ${formatMoney(low.amount)} on ${this.date(low.day)}${causes.length ? `, after the ${list(causes)}` : ''}. That's ${this.vsFloor(low.amount)}.`;
  }
  nextPaychecks(): { day: Day; amount: Cents }[] {
    const isPay = (id: string) => this.h.scheduled.find((s) => s.id === baseId(id))?.kind === 'paycheck';
    return this.forecast60.days.flatMap((d) => d.items.filter((i) => isPay(i.itemId)).map((i) => ({ day: d.day, amount: i.amount })));
  }
  /** The case's state in one plain sentence (null when nothing is open or done). */
  caseStatus(): string | null {
    const c = this.kase;
    const bill = this.billPhrase();
    if (!c) return null;
    const what = bill ? `${cap(bill)} is due ${this.bill!.dueDay === this.today ? 'today' : this.bill!.dueDay !== null ? this.date(this.bill!.dueDay) : 'soon'}` : c.title;
    const deal = this.pendingOf('deal');
    if (this.dealTerms()) return `${what}. Your car lender moved the ${this.itemLabel(this.deal!.itemId)} to ${this.dealTerms()}${this.dealRef ? ` (reference ${this.dealRef})` : ''}, so that's handled.`;
    if (deal) {
      const t = termsFromPrompt(deal.prompt);
      return `${what}. Your car lender offered ${t ? termsPhrase(t) : 'new terms'}, and I'm waiting on your YES or NO before I agree to anything.`;
    }
    if (this.pendingOf('call_limits')) return `${what}. You picked asking your car lender to move the car payment, and I'm waiting on your OK before I call.`;
    if (this.pendingOf('option_choice')) return `${what}. I texted you options to cover it and I'm waiting on your pick.`;
    if (this.pendingOf('bill_confirm')) return `${what}. I'm waiting on you to confirm the bill.`;
    if (c.state === 'DONE') return `${what}. That case is closed.`;
    return `${what}. I'm working on it.`;
  }
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

/** "$300", "300 dollars", "2k", "$1.5k", "$5,000". */
function amountIn(q: string): Cents | null {
  const k = /\$?\s?(\d+(?:\.\d+)?)\s?k\b/i.exec(q);
  if (k) return Math.round(Number(k[1]) * 1000 * 100);
  const m = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:dollars?|bucks|usd)\b/i.exec(q);
  if (!m) return null;
  const whole = Number((m[1] ?? m[3])!.replace(/,/g, ''));
  const frac = m[2] ?? m[4] ? Number((m[2] ?? m[4])!.padEnd(2, '0')) : 0;
  return whole * 100 + frac;
}

/** A day named in the question ("Friday", "tomorrow", "Nov 13"), or null. */
function dayIn(q: string, f: Facts): Day | null {
  const m =
    /\b(today|tonight|tomorrow|(?:next |this )?(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2})\b/i.exec(q);
  if (!m) return null;
  try {
    return parseDay(m[1]!, f.today, f.day0);
  } catch {
    return null;
  }
}

/** Scheduled items a question can name, by the words people use. */
const ITEM_WORDS: [RegExp, string][] = [
  [/\b(?:car payment|car loan payment|auto payment|car note|auto loan payment|loan payment for (?:the|my) car)\b|\bcar\b.*\b(?:due|payment|pay)\b|\b(?:due|payment)\b.*\bcar\b/, 'auto_payment'],
  [/\bmortgage (?:payment|bill|due)\b|\b(?:when|due)\b.*\bmortgage\b|\bmortgage\b.*\b(?:due|come out|hit)\b/, 'mortgage_payment'],
  [/\b(?:utilit\w*|electric\w*|power bill|light bill|energy bill)\b/, 'utilities'],
  [/\b(?:autopay|card payment|credit card payment|card bill)\b/, 'card_autopay'],
  [/\binsurance\b/, 'car_insurance'],
  [/\b(?:phone|internet|wifi)\b/, 'phone_internet'],
  [/\bpersonal loan (?:payment|bill|due)\b|\b(?:when|due)\b.*\bpersonal loan\b/, 'personal_payment'],
];

/** The next time a scheduled item hits checking (on the current plan, so a moved payment shows its new day). */
function nextOf(f: Facts, base: string): { day: Day; amount: Cents; label: string } | null {
  for (const d of f.forecast60.days) {
    const i = d.items.find((x) => baseId(x.itemId) === base);
    if (i) return { day: d.day, amount: i.amount, label: f.itemLabel(i.itemId, i.label) };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------------

function accountLine(f: Facts, id: string, q: string): string | null {
  const a = f.acct(id);
  if (!a) return null;
  const bal = f.bal(id);
  switch (id) {
    case 'checking': {
      const b = f.bill;
      const thought = amountIn(q);
      const not = thought !== null && thought !== bal && /\b(?:thought|i had|i have|isnt it|was it|should be)\b/.test(q) ? `, not ${formatMoney(thought)}` : '';
      const today = b && b.dueDay !== null && b.dueDay <= f.today && f.kase?.state !== 'DONE' ? `, counting ${f.billPhrase()} as paid today` : '';
      return `Checking has ${formatMoney(bal)} right now${not}${today}.`;
    }
    case 'savings':
      return `Savings has ${formatMoney(bal)}; your floor there is ${formatWholeDollars(f.rules().savingsFloor)}.`;
    case 'cd':
      return `Your ${a.name} has ${formatMoney(bal)}${a.apy ? `, earning ${formatPercent(a.apy, 1)} APY` : ''}${a.maturesOn !== undefined ? `, and matures ${f.date(a.maturesOn)}` : ''}.`;
    case 'ira':
      return `Your Roth IRA has ${formatMoney(bal)}. It's off limits, so PacePay never uses it or counts on it.`;
    case 'auto_loan':
      return `You owe ${formatMoney(bal)} on the auto loan${a.apr ? ` at ${formatPercent(a.apr, 1)} APR` : ''}.`;
    case 'personal_loan':
      return `You owe ${formatMoney(bal)} on the personal loan.`;
    case 'mortgage':
      return `You owe ${formatMoney(bal)} on the mortgage.`;
    case 'card':
      return `Your credit card balance is ${formatMoney(bal)}${a.limit ? `, of a ${formatMoney(a.limit)} limit` : ''}.`;
  }
  return `${a.name}: ${formatMoney(bal)}.`;
}

function allBalances(f: Facts): string {
  const has = (id: string) => formatMoney(f.bal(id));
  return `Checking has ${has('checking')}, savings ${has('savings')}, your CD ${has('cd')} and your Roth IRA ${has('ira')} (off limits). You owe ${has('card')} on the card, ${has('auto_loan')} on the auto loan, ${has('personal_loan')} on the personal loan and ${has('mortgage')} on the mortgage.`;
}

function scoreLine(f: Facts, key: ScoreKey, why: boolean): string | null {
  const s = currentScores(f.ctx).find((x) => x.key === key);
  if (!s) return null;
  const label = SCORE_LABELS[key].toLowerCase();
  const head = `Your ${label} is ${s.display}${s.color === 'green' ? ', which is green' : s.color === 'red' ? ', which is red' : ', which is yellow'}.`;
  return `${head} ${s.reason}${s.color !== 'green' || why ? ` ${s.improve}` : ''}`.replace(/\s+/g, ' ').trim();
}

function allScores(f: Facts): string {
  const s = currentScores(f.ctx);
  const parts = s.map((x) => `${SCORE_LABELS[x.key].toLowerCase()} ${x.display} (${x.color})`);
  const red = s.filter((x) => x.color === 'red').map((x) => SCORE_LABELS[x.key].toLowerCase());
  return `Your health scores: ${list(parts)}.${red.length ? ` The ${list(red)} ${red.length > 1 ? 'are' : 'is'} the ones to work on.` : ''}`;
}

/** "Can I afford $300 today?" / "can i drop 2k on a trip friday": what checking does with it, never a verdict. */
function spendWhatIf(f: Facts, q: string, amount: Cents): string {
  const day = Math.max(dayIn(q, f) ?? f.today, f.today);
  const change: Change = f.ctx.engine.billChange(f.h, { amount, day, label: 'What-if purchase' });
  const fc = f.ctx.engine.forecast(f.h, { fromDay: f.today, days: 30, changes: [...f.ctx.store.forecastChanges(), change] });
  const that = fc.days.find((d) => d.day === day);
  const when = day === f.today ? 'today' : `on ${f.date(day)}`;
  const low = fc.lowest;
  return `If ${formatMoney(amount)} comes out of checking ${when}, checking ends that day at ${that ? formatMoney(that.close) : 'about the same'}. The lowest it gets in the next 30 days would be ${formatMoney(low.amount)} on ${f.date(low.day)}, ${f.vsFloor(low.amount)}.`;
}

function cardWhatIf(f: Facts, q: string, amount: Cents): string | null {
  const card = f.ctx.engine.cardAccounts(f.applied)[0];
  if (!card) return null;
  const day = Math.max(dayIn(q, f) ?? f.today, f.today);
  const before = currentScores(f.ctx).find((s) => s.key === 'credit_use');
  const after = currentScores(f.ctx, [{ type: 'charge_card', accountId: card.id, amount, day, label: 'What-if purchase' }]).find((s) => s.key === 'credit_use');
  if (!after || !before) return null;
  return `Putting ${formatMoney(amount)} on the card doesn't touch checking until the card autopay, but card use goes from ${before.display} to ${after.display}. Card balances carry ${card.apr ? `${formatPercent(card.apr, 2)} APR` : 'interest'} if you don't pay them off.`;
}

function transferWhatIf(f: Facts, amount: Cents): string {
  const change: Change = { type: 'transfer', fromAccountId: 'savings', toAccountId: 'checking', amount, day: f.today };
  const applied = f.ctx.engine.applyChanges(f.h, [...f.ctx.store.forecastChanges(), change]);
  const savingsAfter = f.ctx.engine.balancesOn(applied, f.today).get('savings') ?? f.bal('savings') - amount;
  const fc = currentForecast(f.ctx, { days: 30, extra: [change] });
  const sf = f.rules().savingsFloor;
  return `Moving ${formatMoney(amount)} from savings to checking would leave savings at ${formatMoney(savingsAfter)}, ${savingsAfter < sf ? 'under' : 'at or above'} your ${formatWholeDollars(sf)} floor. Checking's lowest would be ${formatMoney(fc.lowest.amount)} on ${f.date(fc.lowest.day)}. You'd make that move at your bank.`;
}

function payDownWhatIf(f: Facts, to: 'card' | 'personal_loan' | 'auto_loan', amount: Cents | null): string {
  const owed = f.bal(to);
  const amt = amount ?? owed;
  const change: Change = { type: 'pay_down', fromAccountId: 'checking', toAccountId: to, amount: amt, day: f.today };
  const fc = currentForecast(f.ctx, { days: 30, extra: [change] });
  const name = to === 'card' ? 'the card' : to === 'personal_loan' ? 'the personal loan' : 'the auto loan';
  const that = fc.days.find((d) => d.day === f.today);
  const extra = to === 'card' && amt >= owed ? ' Card use would drop to 0%.' : ` You'd owe ${formatMoney(Math.max(owed - amt, 0))} on ${name}.`;
  return `Paying ${formatMoney(amt)} on ${name} from checking today would leave checking at ${that ? formatMoney(that.close) : 'less'} today, and its lowest in the next 30 days would be ${formatMoney(fc.lowest.amount)} on ${f.date(fc.lowest.day)}, ${f.vsFloor(fc.lowest.amount)}.${extra}`;
}

function moveItemWhatIf(f: Facts, base: string, q: string): string | null {
  const next = nextOf(f, base);
  const to = dayIn(q, f);
  if (!next || to === null || to <= f.today) return null;
  const item = f.h.scheduled.find((s) => s.id === base);
  if (!item) return null;
  if (next.day === to) return `Your ${next.label} already comes out ${f.date(to)}. ${f.lowestLine()}`;
  const itemId = f.forecast60.days.flatMap((d) => d.items).find((i) => baseId(i.itemId) === base)?.itemId ?? base;
  const fc = currentForecast(f.ctx, { days: 30, extra: [{ type: 'move_item', itemId, toDay: to }] });
  const now = f.forecast30.lowest;
  return `If the ${next.label} moved from ${f.date(next.day)} to ${f.date(to)}, checking's lowest would be ${formatMoney(fc.lowest.amount)} on ${f.date(fc.lowest.day)}, instead of ${formatMoney(now.amount)} on ${f.date(now.day)}. The lender would have to agree, and they may charge a fee.`;
}

function skipWhatIf(f: Facts, base: string): string | null {
  const next = nextOf(f, base);
  if (!next) return null;
  return `Skipping it would keep ${formatMoney(Math.abs(next.amount))} in checking on ${f.date(next.day)}, but the ${next.label} would still be owed and could bring a late fee. I'd plan on paying it on time.`;
}

function cdPick(f: Facts, early: boolean): string | null {
  const cd = f.applied.accounts.find((a) => a.kind === 'cd');
  if (!cd || cd.maturesOn === undefined) return null;
  if (cd.maturesOn < f.today) return `Your CD already matured; it has ${formatMoney(f.bal(cd.id))}.`;
  let pick = '';
  try {
    const opts = f.ctx.engine.cdOptions(f.applied, cd.id, { fromDay: f.today });
    const payoff = opts.find((o) => o.id === 'cd_payoff_card');
    const renew = opts.find((o) => o.id === 'cd_renew');
    const pd = payoff?.changes.find((ch): ch is Extract<Change, { type: 'pay_down' }> => ch.type === 'pay_down');
    const tr = payoff?.changes.find((ch): ch is Extract<Change, { type: 'transfer' }> => ch.type === 'transfer');
    // Same rounding as the CD alert ("about $550 a year").
    const step = (c: Cents) => (Math.abs(c) >= 50_000 ? 5_000 : Math.abs(c) >= 10_000 ? 500 : 100);
    const about = (c: Cents) => formatWholeDollars(Math.round(c / step(c)) * step(c));
    if (payoff && pd) {
      pick = `${early ? 'When it matures,' : `When it matures ${f.date(cd.maturesOn)},`} PacePay's pick is to pay off the card, which will owe ${formatWholeDollars(pd.amount)} by then, and put the other ${formatWholeDollars(tr?.amount ?? 0)} in savings: about ${about(payoff.tradeoffs.yearlyInterestSaved ?? 0)} a year less in card interest.${renew ? ` The other choice is renewing it, which earns about ${about(renew.tradeoffs.yearlyInterestEarned ?? 0)} a year.` : ''}`;
    }
  } catch {
    /* no CD options */
  }
  if (!pick) pick = `It matures ${f.date(cd.maturesOn)}, and I'll text you the choices then.`;
  if (early) return `I'd wait: it matures ${f.date(cd.maturesOn)}, and breaking a CD early usually costs a penalty. ${pick}`;
  return pick;
}

/** The open case's options, numbered, with the engine's tradeoffs. */
function optionsLines(f: Facts): string[] | null {
  const c = f.kase;
  if (!c?.options?.length || c.state === 'DONE') return null;
  return c.options.map((o, i) => {
    const t = o.tradeoffs;
    const bits: string[] = [];
    if (o.id === 'move_payment') bits.push(`at most ${formatWholeDollars(f.rules().feeLimit)} in fees, no new debt`);
    if (t.monthlyInterest) bits.push(`about ${formatMoney(t.monthlyInterest)} a month in card interest`);
    if (t.savingsAfter !== null) bits.push(`savings drops to ${formatMoney(t.savingsAfter)}${o.violations.includes('BELOW_SAVINGS_FLOOR') ? `, under your ${formatWholeDollars(f.rules().savingsFloor)} floor` : ''}`);
    if (!bits.length) bits.push(`lowest checking ${formatMoney(o.lowest.amount)} on ${f.date(o.lowest.day)}`);
    return `${i + 1}. ${o.label}: ${bits.join(', ')}.`;
  });
}

/** "Which option is cheapest?": the options' costs in two sentences. */
function cheapestLine(f: Facts): string | null {
  const opts = f.kase?.options;
  if (!opts?.length) return null;
  const parts = opts.map((o, i) => {
    const t = o.tradeoffs;
    if (o.id === 'move_payment') return `option ${i + 1}, the lender call, costs at most ${formatWholeDollars(f.rules().feeLimit)} in fees with no new debt`;
    if (o.id === 'card') return `option ${i + 1}, the card, adds about ${formatMoney(t.monthlyInterest ?? 0)} a month in interest`;
    if (o.id === 'savings') return `option ${i + 1}, savings, costs nothing but drops savings to ${formatMoney(t.savingsAfter ?? 0)}${o.violations.includes('BELOW_SAVINGS_FLOOR') ? `, under your ${formatWholeDollars(f.rules().savingsFloor)} floor` : ''}`;
    return `option ${i + 1}, ${o.label.toLowerCase()}`;
  });
  return `${cap(parts[0]!)}. ${cap(list(parts.slice(1)))}.`;
}

function explainDay(f: Facts, day: Day): string | null {
  const row = f.forecast30.days.find((d) => d.day === day);
  if (!row) return null;
  const prev = f.forecast30.days.find((d) => d.day === day - 1);
  const out = row.items.filter((i) => i.amount < 0);
  const before = (prev?.items ?? []).filter((i) => i.amount < 0);
  const name = (i: { itemId: string; label: string; amount: Cents }) => `the ${formatMoney(Math.abs(i.amount))} ${f.itemLabel(i.itemId, i.label)}`;
  const pay = f.nextPaychecks().find((p) => p.day > day);
  if (row.intradayLow >= f.floor) return `${f.date(day)} isn't a problem: checking ends that day at ${formatMoney(row.close)}, ${f.vsFloor(row.close)}.`;
  const what = out.length ? `${list(out.map(name))} ${out.length > 1 ? 'come' : 'comes'} out${before.length ? `, a day after ${list(before.map(name))}` : ''}, so ` : '';
  return `On ${f.date(day)}, ${what}checking drops to ${formatMoney(row.intradayLow)}, ${f.vsFloor(row.intradayLow)}.${pay ? ` Your next paycheck doesn't land until ${f.date(pay.day)}.` : ''}`;
}

/** Why the call asks for that day: the first day after the paycheck. */
function whyTargetDay(f: Facts): string | null {
  const ask = f.pendingOf('call_limits') ?? f.pendingOf('deal');
  // Still choosing: the day option 1 (the lender call) would ask for.
  const move = !ask && !f.deal && f.kase?.state !== 'DONE' ? f.kase?.options?.find((o) => o.id === 'move_payment')?.changes.find((ch): ch is Extract<Change, { type: 'move_item' }> => ch.type === 'move_item') : undefined;
  const t = ask ? termsFromPrompt(ask.prompt) : f.deal ? { label: f.date(f.deal.newDay) } : move ? { label: f.date(move.toDay) } : null;
  if (!t) return null;
  const pay = f.nextPaychecks().find((p) => p.day >= f.today);
  const car = nextOf(f, 'auto_payment');
  return `${t.label} comes after your ${pay ? `${f.date(pay.day)} paycheck` : 'next paycheck'}, so checking can cover the ${car ? `${formatMoney(Math.abs(car.amount))} ` : ''}car payment then without going under your ${formatWholeDollars(f.floor)} minimum.`;
}

function lenderSaid(f: Facts): string {
  const n = f.neg;
  const deal = f.pendingOf('deal');
  if (f.dealTerms()) return `Your car lender agreed to move the ${f.itemLabel(f.deal!.itemId)} to ${f.dealTerms()}.${f.dealRef ? ` The reference number is ${f.dealRef}.` : ''}`;
  if (deal) {
    const t = termsFromPrompt(deal.prompt);
    return `Your car lender offered to move the car payment to ${t ? termsPhrase(t) : 'a new date'}. I haven't accepted: I'm waiting on your YES or NO.`;
  }
  if (f.pendingOf('call_limits')) return "I haven't called your lender yet. I'm waiting on your OK before I call.";
  if (!n) return "There hasn't been a lender call yet, so there's nothing from them so far.";
  if (n.state !== 'closed') return "I'm still talking with your car lender. I'll text you before agreeing to anything.";
  return "That lender conversation ended without a deal, so nothing changed.";
}

function feeAnswer(f: Facts): string {
  const deal = f.pendingOf('deal');
  if (f.deal) return f.deal.fee ? `Yes: your car lender charged a ${formatMoney(f.deal.fee)} fee to move the ${f.itemLabel(f.deal.itemId)} to ${f.date(f.deal.newDay)}.` : `No: your car lender moved the ${f.itemLabel(f.deal.itemId)} to ${f.date(f.deal.newDay)} with no fee.`;
  if (deal) {
    const t = termsFromPrompt(deal.prompt);
    return t && t.fee !== null ? `They're asking ${t.fee ? `a ${formatMoney(t.fee)} fee` : 'no fee'} to move it to ${t.label}. Nothing is agreed until you say YES.` : "Nothing is agreed until you say YES to their offer.";
  }
  const limit = formatWholeDollars(f.rules().feeLimit);
  if (f.kase && f.kase.state !== 'DONE') return `No fee has been agreed: I haven't called the lender yet. If I call, I'll keep it to your ${limit} fee limit and check with you first.`;
  return "There's no payment move in progress, so there's no fee.";
}

function callsAnswer(f: Facts): string {
  const n = f.neg;
  const deal = f.pendingOf('deal');
  if (f.dealTerms()) return `Yes: I reached your car lender${n?.channel === 'text' ? ' (we finished by text)' : ''}, and they agreed to move the ${f.itemLabel(f.deal!.itemId)} to ${f.dealTerms()}.`;
  if (deal) return "I'm talking with your car lender now. They made an offer, and I'm waiting on your YES or NO before I agree to anything.";
  if (f.pendingOf('call_limits')) return "Not yet. I'm waiting on your OK before I call your car lender.";
  if (n && n.state === 'closed') return 'I talked with your car lender, but that ended without a deal, so nothing changed.';
  return "No, I haven't called anyone. I only call a lender after you pick that option and OK the limits.";
}

function whyTexted(f: Facts): string {
  const a = f.alert();
  const bill = f.billPhrase();
  if (a && bill) {
    const head = `I texted because paying ${bill} would drop checking to ${a.amount} on ${a.day}, ${a.amount.startsWith('−') ? 'below $0' : `under your ${formatWholeDollars(f.floor)} minimum`}.`;
    if (f.dealTerms()) return `${head} Your car lender has since moved the car payment to ${f.dealTerms()}, so that dip is gone.`;
    return head;
  }
  if (f.kase && bill) return `You sent me ${bill}, so I checked what it does to your week.`;
  return `I haven't sent you an alert: nothing needs fixing right now. ${f.lowestLine()}`;
}

function limitsAnswer(f: Facts): string {
  const limit = formatWholeDollars(f.rules().feeLimit);
  const ask = f.pendingOf('call_limits');
  if (ask) {
    const t = termsFromPrompt(ask.prompt);
    return `I'd ask to move the car payment to ${t ? t.label : 'the first day that works'}, with ${t?.fee != null ? formatMoney(t.fee) : limit} max in fees, and I'd text you before agreeing to anything.`;
  }
  const deal = f.pendingOf('deal');
  if (deal) {
    const t = termsFromPrompt(deal.prompt);
    return `I kept to your ${limit} fee limit and haven't agreed to anything: their offer of ${t ? termsPhrase(t) : 'new terms'} is waiting on your YES or NO.`;
  }
  if (f.dealTerms()) return `I kept to your ${limit} fee limit and only agreed after your YES: ${f.dealTerms()}.`;
  return `Your fee limit is ${limit}. If a call would help, I'll text you the exact limits and wait for your OK before I dial.`;
}

function recap(f: Facts): string {
  const status = f.caseStatus();
  const bal = `Checking has ${formatMoney(f.bal('checking'))} and savings ${formatMoney(f.bal('savings'))}.`;
  if (!status) return `Nothing has needed fixing so far. ${bal} ${f.lowestLine().split('. ')[0]}.`;
  return `${status} ${bal}`;
}

function whatChanged(f: Facts): string {
  if (f.dealTerms()) {
    const a = f.alert(f.ctx.store.list('cases').find((c) => c.negotiationId === f.neg?.id) ?? f.kase);
    const low = f.forecast30.lowest;
    return `Your car payment moved to ${f.dealTerms()}. Checking's lowest is now ${formatMoney(low.amount)} on ${f.date(low.day)}${a ? `, instead of ${a.amount} on ${a.day}` : ''}.`;
  }
  if (f.pendingOf('deal')) return "Nothing has changed yet: the lender's offer is still waiting on your YES or NO.";
  return "There's no deal yet, so nothing has changed in your forecast.";
}

function lastText(f: Facts): string {
  const out = f.ctx.store.thread().filter((m) => m.direction === 'out' && m.text);
  const last = out.at(-1)?.text;
  if (!last) return "I haven't texted you anything yet.";
  const short = last.replace(/\s*\n+\s*/g, ' ');
  return `The last thing I sent you: "${short.length > 220 ? `${short.slice(0, 217).replace(/\s+\S*$/, '')}..." ` : `${short}"`}`.trim();
}

function callLender(f: Facts): string {
  if (f.dealTerms()) return `I already did: your car lender moved the ${f.itemLabel(f.deal!.itemId)} to ${f.dealTerms()}.`;
  if (f.pendingOf('deal')) return "I'm already talking with them. Their offer is waiting on your YES or NO.";
  if (f.pendingOf('call_limits')) return "Yes. Reply YES and I'll call to ask for the date and fee limit I texted you.";
  if (f.pendingOf('option_choice')) {
    const i = (f.pendingOf('option_choice')!.optionIds ?? []).indexOf('move_payment');
    if (i >= 0) return `Yes, that's option ${i + 1}. Reply ${i + 1} and I'll check the call's limits with you before I dial.`;
  }
  return "I call a lender when a bill or alert starts a case and you OK it. Send me a bill photo and I'll check whether a call would help.";
}

function okLine(f: Facts, q: string): string {
  const week = /\bweek\b/.test(q);
  const days = f.forecast30.days.filter((d) => !week || d.day < f.today + 7);
  const low = days.reduce((m, d) => (d.intradayLow < m.intradayLow ? d : m), days[0]!);
  const scope = week ? 'this week' : 'in the next 30 days';
  const fix = f.pendingOf('option_choice') || f.pendingOf('call_limits') ? " The options I texted you are there to fix that." : f.pendingOf('deal') ? " The lender's offer waiting on your YES would move the car payment past that." : '';
  if (low.intradayLow < 0) return `Checking is headed to ${formatMoney(low.intradayLow)} on ${f.date(low.day)} ${scope}, below $0.${fix}`;
  if (low.intradayLow < f.floor) return `Checking dips to ${formatMoney(low.intradayLow)} on ${f.date(low.day)} ${scope}, under your ${formatWholeDollars(f.floor)} minimum.${fix}`;
  return `Checking stays ${f.vsFloor(low.intradayLow)} ${scope}: its lowest is ${formatMoney(low.intradayLow)} on ${f.date(low.day)}.`;
}

/**
 * A text answer from code, or null for the model. `question` is his message as sent.
 */
export function answerInCode(ctx: ToolContext, question: string): string | null {
  const raw = question.trim();
  const q = normalizeReply(raw.replace(/[’]/g, "'")).replace(/\bwhats\b/g, 'what is').replace(/\bhows\b/g, 'how is').replace(/\bwhens\b/g, 'when is');
  const f = new Facts(ctx);

  // Greetings, thanks, "???", emoji.
  if (!q) {
    if (/[💰💵💲🏦]/u.test(raw)) return `Checking has ${formatMoney(f.bal('checking'))} and savings ${formatMoney(f.bal('savings'))}. Ask me about bills, your paycheck or a what-if.`;
    return 'What would you like to know? I can tell you your balances, upcoming bills, your next paycheck, or run a what-if.';
  }
  if (/^(?:hey|hi|hello|yo|sup|hiya|howdy|hey there|hi there|good (?:morning|afternoon|evening)|hola)(?: pacepay)?$/.test(q)) return 'Hey! Ask me anything about your money: your balance, your next paycheck, a bill or a what-if.';
  if (/^(?:thanks|thank you|thank u|thx|ty|tysm|appreciate it|cool thanks|ok thanks|thanks a lot|awesome thanks)(?: pacepay| so much)?$/.test(q)) return "You're welcome! I'm here if you need anything.";
  if (/^(?:hmm+|let me think(?: about it)?|hmm+ let me think(?: about it)?|ill think about it|thinking)$/.test(q)) return "Sure, take your time. I'm here when you need me.";
  if (/^(?:ok|okay|k|kk|cool|got it|nice|great|sounds good)$/.test(q)) return "Sounds good. I'm here if you need anything.";

  // What PacePay is.
  if (/\b(?:who are you|what are you|whats pacepay|what is pacepay|who is this|whos this)\b/.test(q)) return "I'm PacePay, your AI money assistant. I watch your accounts and bills, warn you before checking dips too low, and with your OK I can call a lender to move a payment.";
  if (/\b(?:real person|real human|a human|a person|talking to (?:a )?(?:human|person|someone real))\b|\bare you (?:a )?(?:real|human|person)\b/.test(q)) return "No, you're talking to PacePay, an AI money assistant, not a person. I only act on your clear YES.";
  if (/\bare you (?:an? )?(?:ai|bot|robot|machine|computer|chatbot|llm)\b|\bis this (?:an? )?(?:ai|bot|robot)\b/.test(q)) return "Yes, I'm an AI: PacePay, your money assistant. I never move money, and I only act on your clear YES.";
  if (/\b(?:real person|real human|a human|a person|talking to (?:a )?(?:human|person|someone real))\b/.test(q)) return "No, you're texting PacePay, an AI money assistant, not a person. I only act on your clear YES.";
  if (/\bwhat (?:can|do|else can) you do\b|\bhow (?:can|do) you help\b|\bwhat (?:are|is) you(?:r)? (?:good for|for|features?)\b|\bwhat do you (?:help with|handle)\b/.test(q)) return "I answer questions about your balances, bills, paychecks and what-ifs, and warn you before checking dips too low. Send me a bill photo and I'll check your week; with your OK I can call a lender to move a payment. I never move money myself.";
  if (/\b(?:data|info|information|privacy|private|secure|security|safe)\b/.test(q) && /\b(?:how|is|are|keep|do you)\b/.test(q) && !/\b(?:afford|balance|spend)\b/.test(q)) return "I only read your account data to answer you, and I never move money. I don't send full account or card numbers, SSNs or passwords, and calls about your accounts need your PIN.";
  if (/\b(?:do|does|can|will) (?:you|pacepay) (?:ever )?(?:move|transfer|send|touch) (?:my )?(?:money|funds|cash)\b/.test(q)) return "No. PacePay never moves money: you make any move at your bank. The most I do is ask a lender for a new due date, and only after your YES.";
  if (/\b(?:did you|have you) (?:move|moved|transfer|transferred|send|sent|touch|touched) (?:any )?(?:of )?(?:my )?(?:money|funds|cash)\b/.test(q)) {
    return `No. PacePay never moves money.${f.dealTerms() ? ` With your YES, your car lender moved the car payment to ${f.dealTerms()}.` : ''}`;
  }
  if (/\b(?:can|could|will|would) you (?:please )?(?:call|phone|ring|contact) (?:my |the )?(?:lender|bank|car lender|auto lender|them)\b/.test(q)) return callLender(f);
  if (/\b(?:cost|price|pricing|subscription|how much (?:is|does) pacepay|charge (?:me|for))\b/.test(q) && /\b(?:pacepay|you|this|app|service|it)\b/.test(q)) return "I don't have any pricing to share. Any fee to move a payment comes from the lender, and only with your YES.";
  if (/\bwho (?:built|made|created|developed|designed|owns) (?:you|pacepay|this)\b/.test(q)) return 'PacePay was built by a small team at HackUTD. I work for you, and only act on your clear YES.';
  if (/\b(?:what|which) (?:model|llm|ai)\b|\bgpt\b|\bchatgpt\b|\bclaude\b|\bopenai\b|\bgemini\b/.test(q)) return "I'm an AI money assistant. I can't share the details of the models behind me, but every number I give comes from your own account data.";
  if (/\b(?:which|what) bank\b|\bbank (?:are you|do you) (?:connected|linked|use)\b/.test(q)) return "I can see your checking, savings, CD, Roth IRA, loans and credit card, but I don't have a bank name to share.";
  if (/\b(?:send|text|show) (?:you )?(?:a |my |the )?(?:bill|photo|picture|pic|receipt|statement)\b|\bcan i send\b/.test(q)) return "Yes! Text me a photo of any bill and I'll check what it does to your week.";

  // "Cancel the deal" / "cancel it": what there is to cancel, honestly.
  if (/^(?:please )?(?:cancel|undo|stop|call off)\b/.test(q) || /\bcancel (?:the|my|that) (?:deal|call|move|request|case)\b/.test(q)) {
    if (f.dealTerms()) return `That deal is already done: your car lender moved the car payment to ${f.dealTerms()}. To change it, you'd need to call them yourself.`;
    if (f.pendingOf('deal')) return "I haven't accepted their offer. To turn it down, reply NO.";
    if (f.pendingOf('call_limits')) return "I haven't called anyone. To skip the call, reply NO.";
    return "There's nothing in progress to cancel. PacePay never moves money on its own.";
  }
  if (/\bhow (?:does|do) (?:pacepay|you) make money\b|\bwhats? (?:the|your) business model\b/.test(q)) return "I don't have any pricing or business details to share. I'm here to help with your money, and I only act on your clear YES.";

  // His Roth IRA in a pinch.
  if (/\b(?:use|touch|tap|dip into|pull from|take from|borrow from)\b.*\b(?:ira|roth|retirement)\b/.test(q)) return `No. Your Roth IRA (${formatMoney(f.bal('ira'))}) is off limits, so PacePay never uses it or counts on it.`;

  // What-ifs.
  const amount = amountIn(raw);
  const whatIf = /\b(?:what if|if i|what happens|what would|would i|could i|can i|should i|afford|spend|buy|drop|cover|is .* ok|is .* okay|suppose)\b/.test(q);
  if (/\bskip\b/.test(q)) {
    const base = ITEM_WORDS.find(([re]) => re.test(q))?.[1];
    if (base) return skipWhatIf(f, base);
  }
  if (/\b(?:pay(?:ed|ing)? off|paid off|pay down|payoff)\b.*\b(?:credit card|card)\b/.test(q) && whatIf) return payDownWhatIf(f, 'card', amount);
  if (/\bextra\b.*\b(?:personal loan|car loan|auto loan)\b|\b(?:personal loan|car loan|auto loan)\b.*\bextra\b/.test(q) && amount !== null) return payDownWhatIf(f, /personal/.test(q) ? 'personal_loan' : 'auto_loan', amount);
  if (/\b(?:move|moved|moving|transfer|transferred|shift)\b.*\bfrom (?:my )?savings\b/.test(q) && amount !== null && whatIf) return transferWhatIf(f, amount);
  if (/\b(?:move|moved|moving|push|pushed|delay|delayed)\b.*\b(?:car payment|mortgage|payment)\b/.test(q) && /\bif\b/.test(q)) {
    const base = /mortgage/.test(q) ? 'mortgage_payment' : 'auto_payment';
    const a = moveItemWhatIf(f, base, q);
    if (a) return a;
  }
  if (amount !== null && /\b(?:card|credit card|credit)\b/.test(q) && /\b(?:put|charge|on the|on my|use)\b/.test(q) && whatIf) {
    const a = cardWhatIf(f, q, amount);
    if (a) return a;
  }
  const openBill = f.bill;
  if (amount !== null && whatIf && openBill && amount === openBill.amount && /\b(?:repair|bill|brake|it|this)\b/.test(q)) {
    const status = f.dealTerms() ? `With the car payment moved to ${f.dealTerms()}, ${lc(f.lowestLine())}` : `${f.lowestLine()}${f.pendingOf('option_choice') || f.pendingOf('call_limits') || f.pendingOf('deal') ? ' The options I texted you are there to fix that.' : ''}`;
    return `${cap(f.billPhrase()!)} is already counted as paid today: checking is at ${formatMoney(f.bal('checking'))}. ${status}`;
  }
  if (amount !== null && whatIf && !/\b(?:in (?:my )?checking|thought|limit|fee)\b/.test(q)) return spendWhatIf(f, q, amount);

  // The case, the lender, the history.
  if (/\b(?:what did|whatd|what has|what have|did) (?:the |my )?(?:lender|bank|they|loan company|car lender|lone star)\b|\bhow did (?:the )?(?:call|it) go\b|\bwhat happened (?:on|with) (?:the )?(?:call|lender)\b/.test(q)) return lenderSaid(f);
  if (/\b(?:reference|ref|confirmation) (?:number|no|code|#)?\b/.test(q)) {
    if (f.deal && f.dealRef) return `The reference number is ${f.dealRef}, for moving the ${f.itemLabel(f.deal.itemId)} to ${f.dealTerms()}.`;
    return f.pendingOf('deal') ? "There's no reference number yet: the lender's offer is still waiting on your YES or NO." : "There's no reference number yet, because no deal has been made with a lender.";
  }
  if (/\bfee\b/.test(q) && /\b(?:was there|is there|did they|did it|how much|what is the|whats the|any|charge)\b/.test(q) && !/\bfee limit\b/.test(q)) return feeAnswer(f);
  if (/\b(?:have you|did you|has pacepay) (?:called|call|phoned|contacted|talked to|spoken)\b/.test(q)) return callsAnswer(f);
  if (/\bwhy (?:did|do|are|would) you (?:text|message|ping|alert|contact)\b|\bwhy (?:the|that) (?:text|alert|message)\b/.test(q)) return whyTexted(f);
  if (/\b(?:limits?|max|maximum)\b.*\b(?:call|use|lender)\b|\b(?:call|lender)\b.*\blimits?\b/.test(q) && !/\bcredit limit\b/.test(q)) return limitsAnswer(f);
  if (/\b(?:going on|whats happening|what is happening|status|where are we|update on|what is the plan|whats the plan|what did we decide)\b/.test(q)) return f.caseStatus() ?? "There's no open case right now. Send me a bill photo anytime and I'll check your week.";
  if (/\b(?:recap|summary|summarize|catch me up|everything so far|what did you do|what have you done|what youve done)\b/.test(q)) return recap(f);
  if (/\bwhat (?:has |is )?changed\b|\bwhat is different\b|\bsince the deal\b/.test(q)) return whatChanged(f);
  if (/\blast (?:thing|text|message) you (?:sent|texted)\b|\bwhat did you (?:just )?(?:send|text) me\b/.test(q)) return lastText(f);
  if (/\b(?:explain|what are|what were|tell me|go over|repeat)\b.*\boptions\b|\boptions again\b/.test(q)) {
    const lines = optionsLines(f);
    if (lines) return lines.join('\n');
    return f.dealTerms() ? `There are no options open now: you went with your car lender, who moved the car payment to ${f.dealTerms()}.` : "There are no options open right now. When a bill or a dip needs a fix, I'll text you the choices.";
  }
  if (/\bcheapest\b|\bleast expensive\b|\bcosts? the least\b|\bbest option\b|\bwhich (?:option|one) (?:is|should)\b/.test(q)) {
    const lines = optionsLines(f);
    if (lines) return cheapestLine(f) ?? lines.join('\n');
    return f.dealTerms() ? `That's settled: your car lender moved the car payment to ${f.dealTerms()}.` : "There are no options open right now, so there's nothing to compare.";
  }
  if (/\bwhy not\b.*\b(?:card|credit card)\b|\bwhy (?:not )?(?:just )?(?:use|put it on) (?:the |my )?(?:card|credit card)\b/.test(q)) {
    const c = f.kase?.options?.find((o) => o.id === 'card');
    if (c && f.kase?.state !== 'DONE') {
      const t = c.tradeoffs;
      return `Putting it on the card adds about ${formatMoney(t.monthlyInterest ?? 0)} a month in interest${t.creditUseBefore !== null && t.creditUseAfter !== null ? ` and pushes card use from ${formatPercent(t.creditUseBefore)} to ${formatPercent(t.creditUseAfter)}` : ''}. Moving the car payment avoids new debt. It's still your call: it's one of the options.`;
    }
    return f.dealTerms() ? `You went with your car lender instead, so nothing went on the card: they moved the car payment to ${f.dealTerms()}.` : "There's nothing to put on the card right now. If a bill comes up, I'll compare the card with the other options for you.";
  }
  if (/\bhow (?:did|do) you (?:decide|pick|choose|rank)\b|\bwhy (?:did you )?(?:recommend|pick|suggest)\b/.test(q)) {
    return `I compare each option's lowest checking balance, fees, interest and card use against your rules: a ${formatWholeDollars(f.floor)} checking minimum, a ${formatWholeDollars(f.rules().savingsFloor)} savings floor and a ${formatWholeDollars(f.rules().feeLimit)} fee limit. My pick keeps you above your minimum for the least cost, with no new debt when possible.`;
  }
  if (/\bwhy\b.*\b(?:friday|fri)\b/.test(q)) {
    const a = whyTargetDay(f);
    if (a) return a;
    const d = dayIn(q, f);
    const e = d !== null ? explainDay(f, d) : null;
    if (e) return e;
  }
  if (/\bwhy (?:is|does|will)\b.*\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|fri|sat|sun)\b.*\b(?:problem|bad|issue|negative|low|dip|matter)\b|\bwhat happens (?:on )?(?:monday|tuesday|wednesday|thursday|friday)\b/.test(q)) {
    const d = dayIn(q, f);
    if (d !== null) {
      const a = explainDay(f, d);
      if (a) return a;
    }
  }
  if (/\b(?:brake|repair|bill|it|this)\b.*\b(?:do to|mean for|affect|impact)\b.*\bweek\b|\bcan i afford (?:it|this|that)\b|^(?:can i afford it|can i afford this|can i afford that|afford it)$/.test(q)) {
    const bill = f.billPhrase();
    const a = f.alert();
    if (bill && a) {
      const head = `Paying ${bill} today drops checking to ${a.amount} on ${a.day}, ${a.amount.startsWith('−') ? 'below $0' : `under your ${formatWholeDollars(f.floor)} minimum`}.`;
      if (f.dealTerms()) return `${head.replace('drops', 'would have dropped')} Your car lender moved the car payment to ${f.dealTerms()}, so ${f.lowestLine().replace(/^The lowest/, 'the lowest')}`;
      return `${head} That's why I texted you options.`;
    }
    if (bill) return `${cap(bill)} is counted as paid. ${f.lowestLine()}`;
    return /afford/.test(q) ? 'Afford what? Tell me the amount and the day, like "$200 on Friday", and I\'ll show what it does to checking.' : "I don't see that bill yet. Text me a photo of it and I'll check your week.";
  }

  // CD.
  if (/\bcd\b/.test(q) && /\b(?:break|cash out|early|withdraw)\b/.test(q)) return cdPick(f, true);
  if (/\bcd\b/.test(q) && /\b(?:should|do with|what to do|pick|recommend|matures?|maturing|maturity|renew)\b/.test(q) && !/\b(?:rate|apy|when does|when is|earning)\b/.test(q)) return cdPick(f, false);

  // Net worth, scores.
  if (/\bnet ?worth\b|\bwhat am i worth\b|\bhow much am i worth\b/.test(q)) {
    const nw = currentNetWorth(ctx);
    return `Your net worth is ${formatMoney(nw.netWorth)}: ${formatMoney(nw.assets)} in assets, counting your home, minus ${formatMoney(nw.liabilities)} you owe.`;
  }
  const why = /\bwhy\b/.test(q);
  if (/\b(?:health scores?|my scores|all (?:my |the )?scores|how are my (?:scores|numbers)|scorecard)\b/.test(q)) return allScores(f);
  if (/\b(?:utilization|card use|card usage|credit use|credit usage)\b/.test(q)) return scoreLine(f, 'credit_use', why);
  if (/\bcash cushion\b|\bcushion\b/.test(q)) return scoreLine(f, 'cash_cushion', why);
  if (/\bemergency fund\b|\bmonths of (?:savings|expenses|essentials)\b/.test(q)) return scoreLine(f, 'emergency_fund', why);
  if (/\bdebt (?:to|vs|versus) income\b|\bdti\b/.test(q)) return scoreLine(f, 'debt_to_income', why);

  // Paychecks.
  const pays = f.nextPaychecks();
  if (/\b(?:paycheck|paychecks|pay check|payday|pay day|get paid|direct deposit|salary|wages|paid next)\b/.test(q) || /^wen pay/.test(q)) {
    if (!pays.length) return "I don't see a paycheck scheduled in the next 60 days.";
    const [a, b] = pays;
    if (/\b(?:land(?:ed)?|come in|came in|arrive(?:d)?|hit|deposited|clear(?:ed)?)\b/.test(q) && /\b(?:did|has|yet|already)\b/.test(q)) {
      return `PacePay sees your scheduled paychecks, not live deposits. Your next one, ${formatMoney(a!.amount)}, is scheduled for ${f.date(a!.day)}.`;
    }
    const two = /\b(?:two|2|next few|paychecks)\b/.test(q) && b;
    const multi: string[] = [];
    if (/\bchecking\b|\bchekcing\b/.test(q)) multi.push(accountLine(f, 'checking', q)!);
    if (/\bsavings?\b/.test(q)) multi.push(accountLine(f, 'savings', q)!);
    multi.push(two ? `Your next two paychecks are ${formatMoney(a!.amount)} on ${f.date(a!.day)} and ${formatMoney(b!.amount)} on ${f.date(b!.day)}.` : `Your next paycheck is ${formatMoney(a!.amount)} on ${f.date(a!.day)}.`);
    return multi.join(' ');
  }

  // Lowest point, overdraft, "am I ok".
  if (/\b(?:lowest|low point|how low|bottom out)\b/.test(q)) return f.lowestLine();
  if (/\b(?:overdraft|overdraw\w*|go negative|go below zero|go under|bounce)\b/.test(q) || /\bam i (?:ok|okay|good|fine|alright|all right|broke|screwed|in trouble)\b|\b(?:good|ok|okay|covered) for the week\b|\bbroke\b/.test(q)) {
    const lead = /\bbroke\b|\bam i (?:ok|okay|good|fine|alright|all right)\b/.test(q) && !/\bweek\b/.test(q) ? `Checking has ${formatMoney(f.bal('checking'))} and savings ${formatMoney(f.bal('savings'))}. ` : '';
    return `${lead}${okLine(f, q)}`;
  }

  // Checking on a given day.
  if (/\b(?:checking|balance|have|be)\b/.test(q) && /\b(?:on|by|be on|end|will)\b/.test(q) && /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/.test(q)) {
    const d = dayIn(q, f);
    const row = d !== null ? f.forecast30.days.find((x) => x.day === d) : undefined;
    if (row) return `Checking ends ${f.date(row.day)} at ${formatMoney(row.close)}${row.intradayLow !== row.close ? `; its lowest that day, before deposits land, is ${formatMoney(row.intradayLow)}` : ''}.`;
  }

  // Bills: this week, or one bill's day and amount.
  if (/\bbills?\b.*\b(?:this week|coming up|upcoming|next few days|soon|due)\b|\b(?:what|which) (?:bills|payments)\b|\bwhat is due\b|\bupcoming (?:bills|payments)\b/.test(q) && !ITEM_WORDS.some(([re, id]) => id !== 'auto_payment' && re.test(q))) {
    const horizon = /\bmonth\b/.test(q) ? 30 : 7;
    const items = f.forecast30.days.filter((d) => d.day < f.today + horizon).flatMap((d) => d.items.filter((i) => i.amount < 0).map((i) => `the ${f.itemLabel(i.itemId, i.label)} (${formatMoney(Math.abs(i.amount))}) ${d.day === f.today ? 'today' : `on ${f.date(d.day)}`}`));
    if (!items.length) return `Nothing comes out of checking in the next ${horizon} days.`;
    return `${horizon === 7 ? 'This week' : 'In the next 30 days'}: ${list(items.slice(0, 6))}.`.replace(/the ([^()]*?) bill \(/g, 'the $1 bill (');
  }
  for (const [re, base] of ITEM_WORDS) {
    if (!re.test(q) || /\bowe\b|\bleft\b|\bbalance\b/.test(q) && base !== 'utilities' && base !== 'car_insurance') continue;
    const next = nextOf(f, base);
    if (!next) continue;
    return `Your ${next.label}, ${formatMoney(Math.abs(next.amount))}, comes out ${next.day === f.today ? 'today' : f.date(next.day)}.`;
  }

  // Rules, card terms, CD rate.
  if (/\bfee limit\b|\bmax(?:imum)? fee\b|\bfee cap\b/.test(q)) return `Your fee limit is ${formatWholeDollars(f.rules().feeLimit)}: that's the most PacePay can agree to in fees to move a payment, and only with your YES.`;
  if (/\bwhy\b.*\b(?:keep|need|minimum|floor)\b|\bwhy\b.*\$\d+\b.*\bchecking\b/.test(q) && /\b(?:checking|minimum|floor|100)\b/.test(q)) {
    return `That's your own rule: keep at least ${formatWholeDollars(f.floor)} in checking, so a surprise charge doesn't overdraw you. PacePay warns you before anything would push it lower.`;
  }
  if (/\b(?:minimum|floor|rule|rules)\b/.test(q)) {
    if (/\bsavings\b/.test(q)) return `Your rule is to keep at least ${formatWholeDollars(f.rules().savingsFloor)} in savings.`;
    return `Your rules: keep at least ${formatWholeDollars(f.floor)} in checking and ${formatWholeDollars(f.rules().savingsFloor)} in savings, pay at most ${formatWholeDollars(f.rules().feeLimit)} in fees to move a payment, and the Roth IRA is off limits.`;
  }
  if (/\bcredit limit\b|\blimit on (?:the|my) card\b|\bcard limit\b|\bcard s limit\b/.test(q)) {
    const c = f.acct('card');
    if (c?.limit) return `Your card's limit is ${formatMoney(c.limit)}. You owe ${formatMoney(f.bal('card'))} on it, so ${formatMoney(c.limit - f.bal('card'))} is still available.`;
  }
  if (/\bapr\b|\binterest rate\b/.test(q)) {
    if (/\b(?:car|auto)\b/.test(q) && !/\bcard\b/.test(q)) return `Your auto loan's APR is ${formatPercent(f.acct('auto_loan')?.apr ?? 0, 1)}.`;
    if (/\bpersonal\b/.test(q)) return `Your personal loan's APR is ${formatPercent(f.acct('personal_loan')?.apr ?? 0, 1)}.`;
    const c = f.acct('card');
    if (c?.apr) return `Your credit card's APR is ${formatPercent(c.apr, 2)}.`;
  }
  if (/\bcd\b/.test(q) && /\b(?:rate|apy|earn\w*|interest|mature\w*|maturity)\b/.test(q)) return accountLine(f, 'cd', q);

  // Balances (several in one text: "whats my checking and savings").
  const parts: string[] = [];
  const asksBalance = /\b(?:balance|balanace|have|had|thought|how much|whats in|what is in|left|owe|got|tengo|cuanto|show|tell me|give me|what is my|bal)\b/.test(q);
  if (/\b(?:all|every)\b.*\b(?:balances?|accounts?)\b|\baccount balances\b|\bmy accounts\b/.test(q)) return allBalances(f);
  if (/\bhow much (?:money )?(?:do i have|have i got|i have)\b|\bhow much money\b|\bwhat do i have\b|\bcash do i have\b/.test(q) && !/\b(?:checking|savings|cd|ira|roth)\b/.test(q)) {
    return `You have ${formatMoney(f.bal('checking'))} in checking and ${formatMoney(f.bal('savings'))} in savings, plus ${formatMoney(f.bal('cd'))} in your CD. Your Roth IRA has ${formatMoney(f.bal('ira'))}, but it's off limits.`;
  }
  if (/\b(?:checking|chekcing|chequing|cheques|cuenta)\b/.test(q) && (asksBalance || q.split(' ').length <= 4)) parts.push(accountLine(f, 'checking', q)!);
  if (/\bsavings?\b/.test(q) && !/\bsavings floor\b/.test(q) && (asksBalance || q.split(' ').length <= 4)) parts.push(accountLine(f, 'savings', q)!);
  if (/\bcd\b/.test(q) && asksBalance) parts.push(accountLine(f, 'cd', q)!);
  if (/\b(?:ira|roth|retirement)\b/.test(q)) parts.push(accountLine(f, 'ira', q)!);
  if (/\b(?:auto loan|car loan|on (?:the|my) car|for (?:the|my) car|car)\b/.test(q) && /\b(?:owe|left|balance|loan|pay off)\b/.test(q)) parts.push(accountLine(f, 'auto_loan', q)!);
  if (/\bpersonal loan\b/.test(q)) parts.push(accountLine(f, 'personal_loan', q)!);
  if (/\bmortgage\b/.test(q) && /\b(?:owe|left|balance|how much)\b/.test(q)) parts.push(accountLine(f, 'mortgage', q)!);
  if (/\b(?:credit card|card)\b/.test(q) && /\b(?:balance|owe|how much)\b/.test(q)) parts.push(accountLine(f, 'card', q)!);
  if (parts.length) return parts.join(' ');
  if (/^(?:balance|bal|my balance|balances|whats my balance|what is my balance)$/.test(q) || /\bmy balance\b/.test(q)) return accountLine(f, 'checking', q);
  return null;
}
