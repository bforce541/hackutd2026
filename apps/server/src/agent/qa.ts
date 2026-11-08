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
  formatDate,
  formatMoney,
  formatWholeDollars,
  type Case,
} from '@pacepay/shared';
import type { ChatMessage } from '../models';
import { runTool, type ToolContext } from '../tools/registry';

const MAX_ROUNDS = 4;
const NO_NUMBERS = "I can only discuss account details with the account holder.";
const CANNED = "I couldn't check that just now. Try asking again in a moment.";

function systemPrompt(channel: 'imessage' | 'dashboard' | 'voice', allowNumbers: boolean, context: string): string {
  const style =
    channel === 'voice'
      ? 'You are speaking on a phone call: one or two short sentences, no lists, no markdown.'
      : 'You are replying in a text thread: at most three short sentences, plain text, no markdown, no emoji.';
  return `You are PacePay, Yoshua's money assistant. ${style}
${allowNumbers
    ? `Answer from tool results and the context only. Call get_accounts, get_forecast or simulate to look up anything about his money; you cannot change anything. Tool amounts are integer cents: write them as dollars ("$650", "$1,950.50"). Never add, subtract, round or invent a number: every dollar amount and percentage you write must appear as-is in a tool result (in cents, or as display text such as \"$350\"), in the context, or in his question. For a what-if ("what if I spend 800 today", "what if my paycheck is late", "can I afford X on my card"), call simulate once with just the fields that apply (spend, move_payment, paycheck_late_days or transfer; amounts in plain dollars, days as words like today or Friday, and for "on my card" set spend.from to card). If it returns an error you can fix (a day or amount it couldn't read), fix the fields and call it again; if it says a payment can't be moved, tell him that plainly and stop. Then answer with the lowest checking balance and the date it happens (lowest and lowestOn), and say whether that overdraws checking (below $0), falls under his checking minimum (status and minimum), or stays above it. Don't tell him whether he can or can't afford something; give the numbers. If without.lowest differs, you may add what the lowest point is without the what-if. Only when the money is spent on his card (spend.from card): say it doesn't touch checking until the card autopay, and give the credit use score from the scores. Never mention field names like status or lowestOn. Report values simulate returns and skip anything you would have to work out yourself. Don't mention account ids, category names or tool names. If the tools don't have the answer, say so plainly. `
    : `The person asking has not been verified, so you must not state any amount, balance, date, account detail or percentage, and you do not call tools. Reply only with: "${NO_NUMBERS}"`}
Don't judge his spending. If he asks you to change something (move a payment, call a lender), say that happens when a bill or alert starts a case and he can reply to that text.

CONTEXT (for you; answer in your own words, don't quote it)
${context}`;
}

function describeCase(c: Case | null, ctx: ToolContext): string {
  if (!c) return 'No case is open.';
  const bill = c.billId ? ctx.store.getItem('bills', c.billId) : undefined;
  return `Open case: ${c.title} (state ${c.state}).${bill ? ` Bill: ${formatMoney(bill.amount)} to ${bill.merchant}${bill.dueDay === null ? '' : `, due ${formatDate(bill.dueDay, ctx.store.household().day0Date)}`}.` : ''}`;
}

function buildContext(ctx: ToolContext): string {
  const day0 = ctx.store.household().day0Date;
  const calls = ctx.store.list('calls').filter((c) => c.summary).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const last = calls.at(-1);
  return [
    `Today is ${formatDate(ctx.clock.today(), day0)}.`,
    describeCase(ctx.store.currentCase(), ctx),
    last ? `Last call (${last.direction}, outcome ${last.outcome ?? 'unknown'}): ${last.summary}${last.referenceNumber ? ` Reference ${last.referenceNumber}.` : ''}` : 'No calls yet.',
    `His rules: checking floor ${formatWholeDollars(ctx.store.rules().checkingFloor)}, savings floor ${formatWholeDollars(ctx.store.rules().savingsFloor)}, fee limit ${formatWholeDollars(ctx.store.rules().feeLimit)}.`,
  ].join('\n');
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

  const context = buildContext(ctx);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(opts.channel, true, context) },
    { role: 'user', content: question },
  ];
  const results: unknown[] = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    let text = '';
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const res = await ctx.models.chat({
          role: 'orchestrator',
          messages,
          tools: [...QA_TOOL_NAMES],
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
    if (text.length < 12) continue;
    const bad = ungroundedNumbers(text, results, `${context}\n${question}`);
    if (bad.length === 0) return text;
    ctx.bus.emit({ type: 'tool.result', model: 'nemotron-super', caseId, level: 'warn', title: attempt < 2 ? `Answer had numbers not in the tool results (${bad.join(', ')}); regenerating` : 'Answer still had unverified numbers; dropping those sentences', detail: { text, bad } });
    if (attempt === 2) {
      // Last resort: keep only the sentences whose numbers all check out.
      const kept = text.split(/(?<=[.!?])\s+/).filter((sentence) => ungroundedNumbers(sentence, results, `${context}\n${question}`).length === 0);
      if (kept.length > 0) return kept.join(' ');
      break;
    }
    messages.push({ role: 'user', content: `Your reply contained ${bad.join(', ')}, which is not in the tool results. Rewrite it using only values that appear as-is in the tool results (or in my question), and leave out any figure you would have to calculate.` });
  }
  return CANNED;
}
