/**
 * Tool `send_message` (SPEC §5.6). Implemented by: tools-code.
 * Facts check (SPEC §5.5): every $ amount and % in text must appear in a facts value, else throw
 * FactsCheckError (the caller regenerates once, then sends a template). Sends through
 * ../messaging/outbox.ts sendText; a held text returns messageId ''.
 */
import { TOOLS } from '@pacepay/shared';
import { sendText } from '../messaging/outbox';
import { defineTool } from './registry';

export class FactsCheckError extends Error {
  readonly code = 'facts_check_failed';
  constructor(readonly missing: string[]) {
    super(`send_message: not in facts: ${missing.join(', ')}`);
  }
}

/** "$650", "$1,950.50", and the spelled-out unit: "650 dollars", "20 bucks". */
const MONEY = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:dollars?|bucks)\b/gi;
/** "4.1%", "4.1 %", "4.1 percent". */
const PERCENT = /\d+(?:\.\d+)?\s?(?:%|percent\b)/gi;

/** "$1,500.00" -> "$1500", "650 dollars" -> "$650", "35.50 %" -> "35.5%". Signs are ignored, so "−$300" matches "$300". */
function normalize(token: string): string {
  const pct = /%|percent/i.test(token);
  const n = Number(token.replace(/[^\d.]/g, ''));
  return pct ? `${n}%` : `$${n}`;
}

function tokens(s: string): string[] {
  return [...(s.match(MONEY) ?? []), ...(s.match(PERCENT) ?? [])].map(normalize);
}

/** The $ amounts and percentages in `text` that no facts value contains. Empty means the text is clean. */
export function unsupportedNumbers(text: string, facts: Record<string, string>): string[] {
  const allowed = new Set(Object.values(facts).flatMap(tokens));
  return [...new Set(tokens(text))].filter((t) => !allowed.has(t));
}

export const send_messageTool = defineTool('send_message', TOOLS.send_message.input, TOOLS.send_message.output, async (input, ctx, scope) => {
  const missing = unsupportedNumbers(input.text, input.facts);
  if (missing.length) throw new FactsCheckError(missing);
  const r = await sendText(ctx, input.text, { unprompted: scope.unprompted, caseId: scope.caseId, stepId: scope.stepId, model: scope.model });
  return { messageId: r.sent ? r.message.id : '' };
});
