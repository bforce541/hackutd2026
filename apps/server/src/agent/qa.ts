/**
 * Q&A: answer_question for TEXT events and the inbound call's /ask (SPEC §5.1, §7.4).
 * Super with read-only tools (QA_TOOL_NAMES); numbers only from tool results. Implemented by: model-tools.
 *
 * - allowNumbers false (inbound caller before the PIN): no tools, no figures; any digit in the
 *   reply is replaced by the canned refusal.
 * - allowNumbers true: every $ amount and % in the reply must trace to a tool result or the
 *   context block (SPEC §5.5). Otherwise the reply is regenerated once, then a canned text.
 */
import {
  QA_TOOL_NAMES,
  SCORE_GOALS,
  SCORE_LABELS,
  findDollarAmount,
  formatDate,
  formatMoney,
  formatOneDecimal,
  formatPercent,
  formatWholeDollars,
  type Case,
  type Cents,
  type Change,
  type Day,
  type Household,
} from '@pacepay/shared';
import type { ChatMessage } from '../models';
import { runTool, type ToolContext } from '../tools/registry';
import { parseDay } from '../tools/simulate';
import { currentForecast, currentScores } from '../forecast';

const MAX_ROUNDS = 4;
/** "one hundred dollars": an amount spelled out slips past the facts check, so it is sent back. */
/** A verdict PacePay doesn't give: "you can afford it", "it's not late". */
const VERDICT = /\b(?:yes,? )?you can(?:not|'t|’t)? (?:easily |comfortably )?afford\b|\b(?:is|it's|it’s) not late\b|\bisn['’]t late\b/i;
const SPELLED_MONEY = /\b(?:hundred|thousand|(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\s-]+\w+)?\s+(?:dollars?|bucks))\b/i;
const NO_NUMBERS = "I can only discuss account details with the account holder.";
const CANNED = "I couldn't check that just now. Try asking again in a moment.";

function systemPrompt(channel: 'imessage' | 'dashboard' | 'voice', allowNumbers: boolean, context: string): string {
  const style =
    channel === 'voice'
      ? 'You are speaking on a phone call: one or two short sentences, no lists, no markdown.'
      : 'You are replying in a text thread: one to three short, friendly sentences, plain text, no markdown, no lists, no emoji. Lead with the answer.';
  return `You are PacePay, Yoshua's money assistant. ${style}
${allowNumbers
    ? `Talk to him as "you". FACTS below come from PacePay's engine and are current. Answer from FACTS first. Copy every dollar amount, percentage and date exactly as FACTS writes it ("$1,300", "Mon, Nov 9", "56%"). Never add, subtract, round or work out a number yourself: if the number you want is not written in FACTS or a tool result, leave it out and say it in words. Only when FACTS can't answer a what-if (moving a payment, a transfer, spending not covered below), call simulate once with just the fields that apply (spend, move_payment, paycheck_late_days or transfer; amounts in plain dollars, days as words like today or Friday) and answer with its lowest and lowestOn. Tool amounts are integer cents: write them as dollars. Write every amount in digits exactly as FACTS has it; never spell an amount out in words. For "can I afford" questions, give the numbers (what checking ends that day at, and the lowest point against his minimum) and let him decide; never say "you can afford" or "you can't afford". PacePay sees his scheduled bills and paychecks, not live deposits: if he asks whether money has landed or is late, say when it's scheduled. For what a lender said, give the outcome and the reference number. To explain why a day is a problem, name what comes out around then and what checking drops to, from the day-by-day list; if that dip was in an earlier alert and a fix since removed it, say what caused it then and what fixed it. For the CD, give PacePay's pick and the other choice from FACTS. Never mention ids, field names, tool names or "the engine". If FACTS and the tools don't have it, say so plainly. `
    : `The person asking has not been verified, so you must not state any amount, balance, date, account detail or percentage, and you do not call tools. Reply only with: "${NO_NUMBERS}"`}
Plain names: "card use", "debt vs. income", "cash cushion". Don't judge his spending, never blame. PacePay never moves money: he makes moves at his bank. If he asks you to change something (move a payment, call a lender), say that happens when a bill or alert starts a case and he can reply to that text.

FACTS (for you; answer in your own words, don't quote this block)
${context}`;
}

/** Whole dollars for "about $550 a year" phrases (same rounding as the CD alert). */
function aboutCents(c: Cents): Cents {
  const abs = Math.abs(c);
  const step = abs >= 50_000 ? 5_000 : abs >= 10_000 ? 500 : 100;
  return Math.round(c / step) * step;
}

const baseId = (id: string) => id.split(/[@#:]/)[0]!;
const itemOf = (h: Household, id: string) => h.scheduled.find((s) => s.id === id) ?? h.scheduled.find((s) => s.id === baseId(id));
const signed = (c: Cents) => (c > 0 ? `+${formatMoney(c)}` : formatMoney(c));

const STATE_WORDS: Record<string, string> = {
  NEW: 'just started',
  ANALYZING: 'checking the numbers',
  OPTIONS_SENT: 'options sent, waiting on your pick',
  AWAITING_CHOICE: 'options sent, waiting on your pick',
  ADVISED: 'you picked a fix you make yourself',
  PREPARING_CALL: 'getting ready to call the lender',
  AWAITING_LIMITS: 'waiting on your OK for the call limits',
  REVIEWING: 'second opinion on the call plan',
  CALLING: 'calling the lender',
  NEGOTIATING: 'talking with the lender',
  TEXT_NEGOTIATION: 'talking with the lender by text',
  AWAITING_APPROVAL: "waiting on your yes to the lender's offer",
  CONFIRMING: 'confirming the deal with the lender',
  HOLD_REQUESTED: 'asked the lender to hold the offer',
  SUMMARIZING: 'wrapping up the call',
  DONE: 'done',
};

function describeCase(c: Case | null, ctx: ToolContext): string[] {
  if (!c) return ['Cases: none yet.'];
  const day0 = ctx.store.household().day0Date;
  const bill = c.billId ? ctx.store.getItem('bills', c.billId) : undefined;
  const out = [`${c.state === 'DONE' ? 'Last case (closed)' : 'Open case'}: ${c.title}, ${STATE_WORDS[c.state] ?? c.state}.${bill ? ` Bill: ${formatMoney(bill.amount)} to ${bill.merchant}${bill.dueDay === null ? '' : `, due ${formatDate(bill.dueDay, day0)}`}.` : ''}`];
  // The alert he got (engine-built and facts-checked when it was sent) explains why the case started.
  const alert = c.approvalIds.map((id) => ctx.store.getItem('approvals', id)).find((a) => a?.kind === 'option_choice');
  if (alert) out.push(`The alert PacePay texted you for this case (numbers as of then, before any fix): ${alert.prompt.replace(/\n/g, ' / ')}`);
  if (c.chosenOption) out.push(`You picked: ${c.options?.find((o) => o.id === c.chosenOption)?.label.toLowerCase() ?? c.chosenOption}.`);
  // Still choosing: each option's engine numbers, so "which one is cheapest?" has an answer.
  if (!c.chosenOption && c.options?.length && c.state !== 'DONE') {
    const VIOLATION: Record<string, string> = {
      BELOW_CHECKING_FLOOR: 'checking goes under your minimum',
      BELOW_SAVINGS_FLOOR: 'savings goes under your floor',
      USES_OFF_LIMITS_ACCOUNT: 'uses an off-limits account',
      FEE_OVER_LIMIT: 'fee over your limit',
    };
    out.push('The options in that alert (reply with the number to pick one):');
    c.options.forEach((o, i) => {
      const t = o.tradeoffs;
      const bits = [`lowest checking ${formatMoney(o.lowest.amount)} on ${formatDate(o.lowest.day, day0)}`];
      if (o.id === 'move_payment') bits.push(`a call to your lender, at most ${formatWholeDollars(ctx.store.rules().feeLimit)} in fees, nothing borrowed`);
      bits.push(t.monthlyInterest ? `about ${formatMoney(t.monthlyInterest)} a month in card interest` : 'no new interest');
      if (t.creditUseAfter !== null && t.creditUseBefore !== null && t.creditUseAfter !== t.creditUseBefore) bits.push(`card use ${formatPercent(t.creditUseBefore)} to ${formatPercent(t.creditUseAfter)}`);
      if (t.savingsAfter !== null) bits.push(`savings left ${formatMoney(t.savingsAfter)}`);
      if (o.violations.length) bits.push(`breaks a rule: ${o.violations.map((v) => VIOLATION[v] ?? v).join(', ')}`);
      out.push(`- ${i + 1}. ${o.label}: ${bits.join('; ')}.`);
    });
  }
  const n = c.negotiationId ? ctx.store.getItem('negotiations', c.negotiationId) : undefined;
  const deal = n?.outcome === 'deal' ? [...n.offers].reverse().find((o) => o.readBackConfirmed && (n.checks ?? []).some((k) => k.offerId === o.id && k.pass)) : undefined;
  if (deal) {
    const label = itemOf(ctx.store.household(), deal.itemId)?.label.toLowerCase() ?? 'payment';
    const head = alert ? /Heads up: (\S+) on (\w{3}, \w{3} \d{1,2})/.exec(alert.prompt) : null;
    if (head) out.push(`Fixed since: ${head[2]} was going to be ${head[1]} (that alert); now that the ${label} moved, ${head[2]} is no longer a problem.`);
    out.push(`How it was fixed: the lender moved the ${label} to ${formatDate(deal.newDay, day0)} ${deal.fee ? `for a ${formatMoney(deal.fee)} fee` : 'with no fee'}, so that dip no longer happens; the day-by-day list below already includes the move.`);
  }
  return out;
}

function describeLastCall(ctx: ToolContext): string[] {
  const h = ctx.store.household();
  const negs = ctx.store
    .list('cases')
    .sort((a, b) => (a.openedAt ?? '').localeCompare(b.openedAt ?? ''))
    .map((c) => (c.negotiationId ? ctx.store.getItem('negotiations', c.negotiationId) : undefined))
    .filter((n): n is NonNullable<typeof n> => !!n);
  const n = negs.at(-1);
  const calls = ctx.store.list('calls').sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const call = n ? calls.filter((c) => c.negotiationId === n.id).at(-1) : calls.at(-1);
  if (!n && !call) return ['Lender calls: none yet.'];
  const lender = h.counterparties.find((cp) => cp.id === (n?.counterpartyId ?? call?.counterpartyId))?.name ?? 'the lender';
  const item = n ? itemOf(h, n.itemId) : undefined;
  const lines = [`Last lender conversation: with ${lender}${item ? ` about the ${item.label.toLowerCase()}` : ''}${n?.channel === 'text' ? ' (PacePay negotiated with them by text)' : ' (by phone)'}.`];
  if (n) {
    // Why the call happened: the alert that started its case, then his pick and his OK on the limits.
    const kase = ctx.store.list('cases').find((c) => c.negotiationId === n.id);
    const alert = kase?.approvalIds.map((id) => ctx.store.getItem('approvals', id)).find((a) => a?.kind === 'option_choice');
    const head = alert?.prompt.split('\n')[0]?.trim().replace(/^Heads up:\s*/i, '').replace(/\.$/, '');
    if (head) lines.push(`Why PacePay called them: checking was headed to ${head}. You picked asking the lender to move the payment and said OK to the limits, so PacePay called. Say this in your own words (the dip, then what the lender agreed to); don't quote the alert.`);
    const passed = [...n.offers].reverse().find((o) => o.readBackConfirmed && (n.checks ?? []).some((k) => k.offerId === o.id && k.pass));
    const outcome = n.outcome ?? (n.state === 'closed' ? 'ended' : 'still going');
    if (n.outcome === 'deal' && passed) lines.push(`Outcome: a deal. They moved it to ${formatDate(passed.newDay, h.day0Date)} ${passed.fee ? `for a ${formatMoney(passed.fee)} fee` : 'with no fee'}.`);
    else lines.push(`Outcome: ${String(outcome).replace(/_/g, ' ')}.`);
    const heard = n.offers.filter((o) => o !== passed).map((o) => `${formatDate(o.newDay, h.day0Date)}${o.fee ? ` with a ${formatMoney(o.fee)} fee` : ' with no fee'}`);
    if (heard.length) lines.push(`Other offers they made, which PacePay turned down: ${heard.join('; ')}.`);
  }
  const ref = n?.referenceNumber ?? call?.referenceNumber;
  if (ref) lines.push(`Reference number: ${ref}.`);
  if (call?.summary && n?.outcome !== 'deal') lines.push(`What PacePay texted you after: ${call.summary}`);
  return lines;
}

/** Day words in a question ("Friday", "tomorrow", "Nov 13") -> a demo day, or null. */
function dayIn(question: string, today: Day, day0: string): Day | null {
  const m =
    /\b(today|tonight|tomorrow|(?:next |this )?(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}|\d{1,2}\/\d{1,2})\b/i.exec(question);
  if (!m) return null;
  try {
    return parseDay(m[1]!, today, day0);
  } catch {
    return null;
  }
}

/** "Can I afford a $200 dinner Friday?": the engine's numbers for spending it from checking and on the card. */
function spendFacts(ctx: ToolContext, question: string, applied: Household, nums: number[]): string[] {
  const amount = findDollarAmount(question);
  if (amount === null || !/afford|spend|buy|pay for|purchase|dinner|trip|cost|charge|put .* on|use .* card/i.test(question)) return [];
  const h = ctx.store.household();
  const day0 = h.day0Date;
  const today = ctx.clock.today();
  const day = Math.max(dayIn(question, today, day0) ?? today, today);
  const floor = h.rules.checkingFloor;
  const base = ctx.store.forecastChanges();
  const fromChecking: Change = ctx.engine.billChange(h, { amount, day, label: 'What-if purchase' });
  const f = ctx.engine.forecast(h, { fromDay: today, days: 30, changes: [...base, fromChecking] });
  const that = f.days.find((d) => d.day === day);
  const low = f.lowest;
  nums.push(amount, low.amount, ...(that ? [that.close] : []));
  const lines = [
    `What-if, ${formatMoney(amount)} from checking on ${formatDate(day, day0)}: checking ends that day at ${that ? formatMoney(that.close) : 'unknown'}; the lowest in the next 30 days would be ${formatMoney(low.amount)} on ${formatDate(low.day, day0)}, which is ${low.amount < 0 ? 'below $0 (overdrawn)' : low.amount < floor ? `under your ${formatWholeDollars(floor)} minimum` : `at or above your ${formatWholeDollars(floor)} minimum`}.`,
  ];
  const card = ctx.engine.cardAccounts(applied)[0];
  if (card) {
    const after = ctx.engine.healthScores(h, { fromDay: today, changes: [...base, { type: 'charge_card', accountId: card.id, amount, day, label: 'What-if purchase' }] }).find((s) => s.key === 'credit_use');
    if (after) {
      nums.push(after.value);
      lines.push(`What-if, ${formatMoney(amount)} on the credit card on ${formatDate(day, day0)}: checking doesn't change until the card autopay; card use would be ${after.display}.`);
    }
  }
  return lines;
}

/**
 * The facts object for one question: balances, the next 14 days, paychecks, the lowest point, the four
 * scores with goals, the CD choice, the open or last case, the last call, his rules. All engine output,
 * written as display text; `nums` collects the same values in cents (or ratios) for the facts check.
 */
export function buildFacts(ctx: ToolContext, question = ''): { text: string; nums: number[] } {
  const h = ctx.store.household();
  const day0 = h.day0Date;
  const today = ctx.clock.today();
  const rules = ctx.store.rules();
  const nums: number[] = [];
  const applied = ctx.engine.applyChanges(h, ctx.store.forecastChanges());
  const now = ctx.engine.balancesOn(applied, today);
  const lines: string[] = [`Today is ${formatDate(today, day0)}.`, 'Balances now (after today\'s items):'];
  for (const a of applied.accounts) {
    const bal = now.get(a.id) ?? a.balance;
    nums.push(bal);
    const extra: string[] = [];
    if (a.kind === 'credit_card' && a.limit) extra.push(`owed, of a ${formatMoney(a.limit)} limit`);
    else if (a.isLiability) extra.push('owed');
    if (a.apr) extra.push(`${formatPercent(a.apr, 2).replace(/\.?0+%$/, '%')} APR`);
    if (a.apy) extra.push(`${formatPercent(a.apy, 1)} APY`);
    if (a.maturesOn !== undefined) extra.push(`matures ${formatDate(a.maturesOn, day0)}`);
    if (a.offLimits) extra.push('off limits');
    lines.push(`- ${a.name}: ${formatMoney(bal)}${extra.length ? ` (${extra.join(', ')})` : ''}`);
  }

  const f = currentForecast(ctx, { days: 30 });
  lines.push('Checking, next 14 days (days with money in or out; "lowest" is before that day\'s deposits land):');
  for (const d of f.days.filter((x) => x.day < today + 14 && x.items.length)) {
    const items = d.items.map((i) => `${i.label} ${signed(i.amount)}`).join(', ');
    nums.push(d.close, d.intradayLow, ...d.items.map((i) => i.amount));
    lines.push(`- ${formatDate(d.day, day0)}: ${items}. Checking ends the day at ${formatMoney(d.close)}${d.intradayLow !== d.close ? `, lowest ${formatMoney(d.intradayLow)}` : ''}.`);
  }
  const paydays = f.days.filter((d) => d.items.some((i) => itemOf(applied, i.itemId)?.kind === 'paycheck'));
  if (paydays.length) {
    const amt = paydays[0]!.items.find((i) => itemOf(applied, i.itemId)?.kind === 'paycheck')!.amount;
    nums.push(amt);
    lines.push(`Next paycheck: ${formatMoney(amt)} on ${formatDate(paydays[0]!.day, day0)}${paydays[1] ? `, then ${formatDate(paydays[1].day, day0)}` : ''} (every other ${formatDate(paydays[0]!.day, day0).slice(0, 3)}).`);
  }
  nums.push(f.lowest.amount, rules.checkingFloor, rules.savingsFloor, rules.feeLimit);
  const neg = f.days.find((d) => d.intradayLow < 0);
  const causes = f.lowest.causeItemIds.map((id) => itemOf(applied, id)?.label.toLowerCase()).filter(Boolean);
  lines.push(
    `Lowest checking in the next 30 days: ${formatMoney(f.lowest.amount)} on ${formatDate(f.lowest.day, day0)}${causes.length ? ` (after the ${[...new Set(causes)].join(', ')})` : ''}; your minimum is ${formatWholeDollars(rules.checkingFloor)}. ${neg ? `First day below $0: ${formatDate(neg.day, day0)} (${formatMoney(neg.intradayLow)}).` : 'Checking never goes below $0.'}`,
  );

  lines.push('Health scores:');
  for (const s of currentScores(ctx)) {
    nums.push(s.value);
    lines.push(`- ${SCORE_LABELS[s.key]}: ${s.display} (${s.color}). ${SCORE_GOALS[s.key]}. ${s.reason} To improve: ${s.improve}`);
  }

  const cd = applied.accounts.find((a) => a.kind === 'cd');
  if (cd && (cd.maturesOn ?? 0) >= today) {
    try {
      const opts = ctx.engine.cdOptions(applied, cd.id, { fromDay: today });
      const payoff = opts.find((o) => o.id === 'cd_payoff_card');
      const renew = opts.find((o) => o.id === 'cd_renew');
      const pd = payoff?.changes.find((ch): ch is Extract<Change, { type: 'pay_down' }> => ch.type === 'pay_down');
      const tr = payoff?.changes.find((ch): ch is Extract<Change, { type: 'transfer' }> => ch.type === 'transfer');
      const t = payoff?.tradeoffs;
      if (payoff && pd && t) {
        const saved = aboutCents(t.yearlyInterestSaved ?? 0);
        nums.push(pd.amount, tr?.amount ?? 0, saved, t.emergencyMonthsBefore ?? 0, t.emergencyMonthsAfter ?? 0);
        lines.push(
          `The ${formatMoney(cd.balance)} CD, when it matures ${formatDate(cd.maturesOn!, day0)}. PacePay's pick: pay off the card (${formatWholeDollars(pd.amount)}) and put ${formatWholeDollars(tr?.amount ?? 0)} in savings; saves about ${formatWholeDollars(saved)} a year in card interest, and your emergency fund goes from ${formatOneDecimal(t.emergencyMonthsBefore ?? 0)} to ${formatOneDecimal(t.emergencyMonthsAfter ?? 0)} months.${renew ? ` The other choice: renew it, which earns about ${formatWholeDollars(aboutCents(renew.tradeoffs.yearlyInterestEarned ?? 0))} a year.` : ''} You make the move at your bank.`,
        );
        if (renew) nums.push(aboutCents(renew.tradeoffs.yearlyInterestEarned ?? 0));
      }
    } catch {
      /* no CD facts */
    }
  }

  lines.push(...describeCase(ctx.store.currentCase(), ctx));
  lines.push(...describeLastCall(ctx));
  const watch = ctx.store.list('followups').filter((x) => x.status === 'scheduled');
  for (const w of watch) lines.push(`Scheduled text for ${formatDate(w.atDay, day0)}${w.atTime ? ` ${w.atTime}` : ''}: "${w.text}"`);
  lines.push(`Your rules: keep at least ${formatWholeDollars(rules.checkingFloor)} in checking and ${formatWholeDollars(rules.savingsFloor)} in savings; at most ${formatWholeDollars(rules.feeLimit)} in fees to move a payment; the Roth IRA is off limits.`);
  lines.push(...spendFacts(ctx, question, applied, nums));
  return { text: lines.join('\n'), nums };
}

/** Every number leaf in a JSON value. */
function leaves(v: unknown, out: number[] = []): number[] {
  if (typeof v === 'number') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => leaves(x, out));
  return out;
}

// "$650", "650 dollars", "4.1%", "4.1 percent": SPEC §5.5 checks every $ amount and %.
const NUM = /[-−]?\$\s?[\d,]+(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:dollars?|bucks)\b|\d+(?:\.\d+)?\s?(?:%|percent\b)/gi;

/** Tokens in `text` that are not backed by any tool result number or context string. */
export function ungroundedNumbers(text: string, toolResults: unknown[], context: string): string[] {
  const nums = leaves(toolResults);
  const ctxStrings = new Set((context.match(NUM) ?? []).map((s) => s.replace(/[\s−-]/g, '')));
  return (text.match(NUM) ?? []).filter((tok) => {
    const compact = tok.replace(/[\s−-]/g, '');
    if (ctxStrings.has(compact)) return false;
    const value = Number(compact.replace(/[^\d.]/g, ''));
    if (/%|percent/i.test(tok)) return !nums.some((n) => Math.abs(n - value) < 0.5 || Math.abs(n * 100 - value) < 0.5);
    return !nums.some((n) => Math.abs(Math.abs(n) / 100 - value) < 0.5 || Math.abs(Math.abs(n) - value) < 0.005);
  });
}

export async function answerQuestion(
  ctx: ToolContext,
  question: string,
  opts: { channel: 'imessage' | 'dashboard' | 'voice'; allowNumbers: boolean },
): Promise<string> {
  const caseId = ctx.store.currentCase()?.id;
  if (!opts.allowNumbers) return NO_NUMBERS;
  if (!ctx.models.available('orchestrator')) return CANNED;

  let context: string;
  const results: unknown[] = [];
  try {
    const facts = buildFacts(ctx, question);
    context = facts.text;
    results.push(facts.nums);
  } catch (err) {
    ctx.bus.emit({ type: 'tool.result', model: 'engine', caseId, level: 'warn', title: `Q&A facts incomplete: ${(err as Error).message}` });
    context = `Today is ${formatDate(ctx.clock.today(), ctx.store.household().day0Date)}.`;
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(opts.channel, true, context) },
    { role: 'user', content: question },
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    let text = '';
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const res = await ctx.models.chat({
          role: 'orchestrator',
          messages,
          // The last round has no tools, so the model has to answer with what it has.
          tools: round < MAX_ROUNDS - 1 ? [...QA_TOOL_NAMES] : undefined,
          caseId,
          title: 'Super answered a question',
        });
        messages.push(res.assistantMessage);
        if (res.toolCalls.length === 0) {
          text = res.text.trim();
          break;
        }
        for (const call of res.toolCalls) {
          let content: string;
          if (!(QA_TOOL_NAMES as readonly string[]).includes(call.name)) {
            content = JSON.stringify({ error: `${call.name} is not available` });
          } else {
            try {
              const out = await runTool(call.name as (typeof QA_TOOL_NAMES)[number], call.arguments ?? {}, ctx, { caseId, caller: 'qa', model: 'nemotron-super' });
              results.push(out);
              content = JSON.stringify(out);
            } catch (err) {
              content = JSON.stringify({ error: (err as Error).message });
            }
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content });
        }
      }
    } catch (err) {
      ctx.bus.emit({ type: 'tool.result', model: 'nemotron-super', caseId, level: 'warn', title: `Q&A model failed: ${(err as Error).message}` });
      return CANNED;
    }
    text = text.replace(/\*\*/g, '').replace(/(^|[\s(])-\$/g, '$1−$').trim();
    if (text.length < 12) {
      ctx.bus.emit({ type: 'tool.result', model: 'nemotron-super', caseId, level: 'warn', title: 'Q&A model gave no answer; asking again' });
      messages.push({ role: 'user', content: 'Answer the question now in at most 3 short sentences, from FACTS.' });
      continue;
    }
    text = text.replace(/\s*\n+\s*/g, ' ');
    const style = SPELLED_MONEY.test(text)
      ? 'Write amounts as digits copied from FACTS (like "$100"), never spelled out in words.'
      : (text.match(/(?:^|\s)[-•*] (?=\S)/g) ?? []).length >= 2
        ? 'No lists or bullets: answer in plain sentences.'
        : VERDICT.test(text)
        ? 'Don\'t say whether he can or can\'t afford it, or that a payment is or isn\'t late; give the numbers or the scheduled day and let him decide.'
        : /\b(FACTS|the facts|in the facts|(?:not|isn'?t|wasn'?t) (?:provided|given|listed|mentioned)|tool results?)\b/.test(text)
        ? 'Never mention FACTS, "the facts", tool results, or what was or wasn\'t provided; just answer him directly, as PacePay.'
        : null;
    if (style && attempt < 2) {
      ctx.bus.emit({ type: 'tool.result', model: 'nemotron-super', caseId, level: 'warn', title: `Answer broke a style rule; rewriting`, detail: { text } });
      messages.push({ role: 'user', content: `${style} Answer again in at most 3 short sentences.` });
      continue;
    }
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean).length;
    if (opts.channel !== 'voice' && (sentences > 3 || text.length > 380) && attempt < 2) {
      ctx.bus.emit({ type: 'tool.result', model: 'nemotron-super', caseId, level: 'warn', title: `Answer too long (${sentences} sentences); asking for a shorter one`, detail: { text } });
      messages.push({ role: 'user', content: 'Too long. Answer again in at most 3 short sentences, plain text, copying amounts exactly as FACTS writes them.' });
      continue;
    }
    const bad = ungroundedNumbers(text, results, `${context}\n${question}`);
    if (bad.length === 0) return text;
    ctx.bus.emit({ type: 'tool.result', model: 'nemotron-super', caseId, level: 'warn', title: attempt < 2 ? `Answer had numbers not in the tool results (${bad.join(', ')}); regenerating` : 'Answer still had unverified numbers; dropping those sentences', detail: { text, bad } });
    if (attempt === 2) {
      // Last resort: keep only the sentences whose numbers all check out.
      const kept = text.split(/(?<=[.!?])\s+/).filter((sentence) => ungroundedNumbers(sentence, results, `${context}\n${question}`).length === 0);
      if (kept.length > 0) return kept.join(' ');
      break;
    }
    messages.push({ role: 'user', content: `Your reply contained ${bad.join(', ')}, which is not written in FACTS or the tool results. Rewrite it in 1 to 3 short sentences, copying amounts exactly as FACTS writes them, and say any figure you would have to calculate in words instead.` });
  }
  return CANNED;
}
