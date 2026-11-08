/**
 * Tool `simulate` (SPEC §5.6). Implemented by: tools-code.
 * engine.simulate(household, [...forecastChanges, ...changes], { fromDay }). Changes nothing.
 *
 * The model fills in friendly fields ({ spend: { amount_dollars: 800 } }, "Friday", "car payment");
 * this file turns them into engine Changes, resolving day words from the demo clock. Raw engine
 * Changes in `changes` still work. The output carries the lowest point, its date and a status, all
 * from the engine, so the answer never needs arithmetic.
 */
import { ChangeSchema, formatDate, isoDateToDay, weekdayOf, dayToISODate, WEEKDAYS, type Change, type Day, type Household } from '@pacepay/shared';
import type { Engine } from './registry';
import { defineTool } from './registry';
import { TOOLS } from '@pacepay/shared';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAY_NAMES = WEEKDAYS.map((w) => w.toLowerCase());
const CANT_READ_DAY = (s: string) => new Error(`I can't read the day "${s}". Use today, tomorrow, a weekday like Friday, or a date like Nov 13.`);

/** "today", "tomorrow", "Friday", "next Friday", "in 3 days", "Nov 13", "11/13", "the 13th" -> demo day. */
export function parseDay(raw: string, today: Day, day0Date: string): Day {
  const s = raw.trim().toLowerCase().replace(/[,.]/g, ' ').replace(/\b(on|this|the|by|at)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (s === '') throw CANT_READ_DAY(raw);
  if (/^(today|tonight|now)$/.test(s)) return today;
  if (s === 'tomorrow') return today + 1;
  if (/^day after tomorrow$/.test(s)) return today + 2;
  const rel = /^(?:in )?(\d+) days?(?: from now| later)?$/.exec(s);
  if (rel) return today + Number(rel[1]);
  if (/^\d+$/.test(s)) return Number(s); // an engine day number
  const wd = /^(next )?([a-z]+)$/.exec(s);
  if (wd) {
    const idx = (wd[2] as string).length >= 3 ? WEEKDAY_NAMES.indexOf((wd[2] as string).slice(0, 3)) : -1;
    if (idx >= 0) {
      let d = today;
      while (weekdayOf(d, day0Date) !== WEEKDAYS[idx] || (wd[1] && d === today)) d += 1;
      return d;
    }
  }
  const year = Number(day0Date.slice(0, 4));
  const iso = (m: number, d: number, y = year) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const valid = (m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31;
  let m: number | undefined;
  let d: number | undefined;
  let hit: RegExpExecArray | null;
  if ((hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return isoDateToDay(s, day0Date);
  if ((hit = /^(\d{1,2})\/(\d{1,2})$/.exec(s))) [m, d] = [Number(hit[1]), Number(hit[2])];
  else if ((hit = /^([a-z]{3,9}) (\d{1,2})(?:st|nd|rd|th)?$/.exec(s))) [m, d] = [MONTHS.indexOf((hit[1] as string).slice(0, 3)) + 1, Number(hit[2])];
  else if ((hit = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})$/.exec(s))) [m, d] = [MONTHS.indexOf((hit[2] as string).slice(0, 3)) + 1, Number(hit[1])];
  if (m !== undefined && d !== undefined && valid(m, d)) {
    let day = isoDateToDay(iso(m, d), day0Date);
    if (day < today) day = isoDateToDay(iso(m, d, year + 1), day0Date);
    return day;
  }
  if ((hit = /^(\d{1,2})(?:st|nd|rd|th)$/.exec(s))) {
    // "the 13th": the next date with that day of the month
    for (let day = today; day < today + 62; day += 1) if (Number(dayToISODate(day, day0Date).slice(8)) === Number(hit[1])) return day;
  }
  throw CANT_READ_DAY(raw);
}

function dollarsToCents(v: number | string, what: string): number {
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, '').replace(/dollars?|bucks/i, ''));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${what} needs a positive dollar amount, like 800.`);
  return Math.round(n * 100);
}

/** An account by id, name or word ("card", "credit card", "savings", "checking"). */
function findAccount(h: Household, word: string): Household['accounts'][number] {
  const w = word.trim().toLowerCase();
  const kinds: Record<string, string> = { check: 'checking', debit: 'checking', sav: 'savings', card: 'credit_card', credit: 'credit_card' };
  const kind = Object.entries(kinds).find(([k]) => w.includes(k))?.[1];
  const acct = h.accounts.find((a) => a.id === w || a.name.toLowerCase() === w) ?? h.accounts.find((a) => a.kind === kind);
  if (!acct) throw new Error(`I don't know the account "${word}". Use checking, savings or card.`);
  if (acct.offLimits) throw new Error(`${acct.name} is off limits.`);
  return acct;
}

const PAYMENT_STOPWORDS = new Set(['the', 'my', 'a', 'payment', 'payments', 'bill', 'bills', 'due', 'date']);

function findPayment(h: Household, word: string) {
  const candidates = h.scheduled.filter((s) => !/[#@]/.test(s.id) && s.kind !== 'paycheck' && s.kind !== 'card_spend');
  const q = word.trim().toLowerCase();
  const exact = candidates.filter((s) => s.id === q || s.label.toLowerCase() === q);
  const words = q.split(/[^a-z]+/).filter((x) => x && !PAYMENT_STOPWORDS.has(x));
  const hay = (s: (typeof candidates)[number]) => `${s.id.replace(/_/g, ' ')} ${s.label}`.toLowerCase();
  const loose = candidates.filter((s) => words.length > 0 && words.some((x) => hay(s).includes(x)));
  const hits = exact.length > 0 ? exact : loose;
  if (hits.length !== 1) {
    throw new Error(`${hits.length === 0 ? `I can't find a payment called "${word}"` : `"${word}" matches more than one payment`}. Movable payments: ${candidates.filter((s) => s.movable).map((s) => s.label).join(', ')}.`);
  }
  const item = hits[0] as (typeof candidates)[number];
  if (!item.movable) throw new Error(`${item.label} can't be moved. Movable payments: ${candidates.filter((s) => s.movable).map((s) => s.label).join(', ')}.`);
  return item;
}

/** The next occurrence of a recurring item on or after `today`, and the one after it. */
function upcoming(engine: Engine, h: Household, itemId: string, today: Day): [Day, Day | undefined] {
  const item = h.scheduled.find((s) => s.id === itemId);
  if (!item) throw new Error(`No scheduled item ${itemId}.`);
  const days = engine.occurrences(h, item, today + 120).filter((d) => d >= today);
  return [days[0] ?? item.day, days[1]];
}

export const simulateTool = defineTool('simulate', TOOLS.simulate.input, TOOLS.simulate.output, async (input, ctx) => {
  const h = ctx.store.household();
  const today = ctx.clock.today();
  const day0 = h.day0Date;
  const on = (d: Day) => formatDate(d, day0);
  const day = (word: string | undefined, fallback: Day = today): Day => {
    const d = word === undefined || word === '' ? fallback : parseDay(word, today, day0);
    if (d < today) throw new Error(`${on(d)} is in the past (today is ${on(today)}).`);
    return d;
  };

  const changes: Change[] = [];
  const applied: { what: string; amount?: number; on?: string }[] = [];

  if (input.spend) {
    const amount = dollarsToCents(input.spend.amount_dollars, 'spend');
    const d = day(input.spend.day);
    const from = (input.spend.from ?? 'checking').toLowerCase();
    if (/card|credit/.test(from)) {
      const card = engineCard(ctx.engine, h);
      changes.push({ type: 'charge_card', accountId: card, amount, day: d, label: 'What-if purchase' });
      applied.push({ what: 'Spend on the credit card', amount, on: on(d) });
    } else if (/check|debit|^$/.test(from)) {
      changes.push(ctx.engine.billChange(h, { amount, day: d, label: 'What-if purchase' }));
      applied.push({ what: 'Spend from checking', amount, on: on(d) });
    } else throw new Error(`spend.from must be 'checking' or 'card', not "${input.spend.from}".`);
  }

  if (input.move_payment) {
    const item = findPayment(h, input.move_payment.item);
    const to = day(input.move_payment.to_day);
    const [next, after] = upcoming(ctx.engine, h, item.id, today);
    if (to < next && next !== item.day) throw new Error(`The next ${item.label} is due ${on(next)}; I can only move it to a later day.`);
    if (after !== undefined && to >= after) throw new Error(`The next ${item.label} is due ${on(next)}; pick a day before ${on(after)}.`);
    changes.push({ type: 'move_item', itemId: item.id, toDay: to });
    applied.push({ what: `Move the ${item.label} due ${on(next)}`, on: on(to) });
  }

  if (input.paycheck_late_days !== undefined) {
    const n = Math.round(input.paycheck_late_days);
    const pay = h.scheduled.find((s) => s.kind === 'paycheck');
    if (!pay) throw new Error('There is no paycheck on file.');
    if (n < 1 || n > 13) throw new Error('paycheck_late_days must be between 1 and 13.');
    const [next] = upcoming(ctx.engine, h, pay.id, today);
    changes.push({ type: 'move_item', itemId: pay.id, toDay: next + n });
    applied.push({ what: `Paycheck due ${on(next)} arrives ${n} day${n === 1 ? '' : 's'} late`, amount: pay.amount, on: on(next + n) });
  }

  if (input.transfer) {
    const amount = dollarsToCents(input.transfer.amount_dollars, 'transfer');
    const from = findAccount(h, input.transfer.from ?? 'savings');
    const to = findAccount(h, input.transfer.to ?? 'checking');
    if (from.id === to.id) throw new Error('A transfer needs two different accounts.');
    const d = day(input.transfer.day);
    changes.push({ type: to.isLiability ? 'pay_down' : 'transfer', fromAccountId: from.id, toAccountId: to.id, amount, day: d });
    applied.push({ what: `Move money from ${from.name} to ${to.name}`, amount, on: on(d) });
  }

  if (input.changes && input.changes.length > 0) {
    const raw = ChangeSchema.array().safeParse(input.changes);
    if (!raw.success) throw new Error('changes is not valid. Use spend, move_payment, paycheck_late_days or transfer instead.');
    changes.push(...raw.data);
    applied.push({ what: `${raw.data.length} raw change${raw.data.length === 1 ? '' : 's'}` });
  }

  if (changes.length === 0) throw new Error('Nothing to simulate: fill in spend, move_payment, paycheck_late_days or transfer.');

  const base = ctx.store.forecastChanges();
  const r = ctx.engine.simulate(h, [...base, ...changes], { fromDay: today });
  const without = ctx.engine.forecast(h, { fromDay: today, days: ctx.engine.CHART_HORIZON_DAYS, changes: base }).lowest;
  const lowest = { amount: r.forecast.lowest.amount, day: r.forecast.lowest.day };
  const minimum = h.rules.checkingFloor;
  return {
    lowest,
    lowestOn: on(lowest.day),
    status: lowest.amount < 0 ? 'below_zero' : lowest.amount < minimum ? 'below_minimum' : 'ok',
    minimum,
    without: { lowest: { amount: without.amount, day: without.day }, lowestOn: on(without.day) },
    applied,
    scores: r.scores,
    netWorth: r.netWorth,
  };
});

function engineCard(engine: Engine, h: Household): string {
  const card = engine.cardAccounts(h)[0];
  if (!card) throw new Error('There is no credit card on file.');
  return card.id;
}
