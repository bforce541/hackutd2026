/**
 * SPEC §5.1 reply parsing. Code, not a model: trim, lowercase, strip punctuation.
 * Order: a dollar-amount correction (only while the bill is unconfirmed), then yes/no, then a choice.
 * Shared so the server, the demo script and the dashboard's demo mode classify replies the same way.
 */
import { dollarsToCents } from './format';
import type { Cents } from './types';

export type ParsedReply =
  | { kind: 'correction'; amount: Cents }
  | { kind: 'choice'; choice: number }
  | { kind: 'yes' }
  | { kind: 'no' }
  | { kind: 'text' };

export interface ReplyContext {
  /** The case's bill is unconfirmed (SPEC §5.1 "Detecting a correction"). */
  billUnconfirmed?: boolean;
  /** Pending option_choice approval's optionIds.length; a choice counts only within 1..choiceCount. */
  choiceCount?: number;
}

const YES = /^(y|yes|yep|ok|approve|approved)$/;
const NO = /^(n|no|nope|decline)$/;
const CHOICE = /^[1-9]$/;

/** Lowercase, trim, and strip punctuation (keeps letters, digits and spaces). */
export function normalizeReply(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A dollar amount in free text: "$700", "$700.50", "$1,200", "700 dollars", "700 bucks".
 * A bare number such as "1" is not an amount.
 */
export function findDollarAmount(text: string): Cents | null {
  const withSign = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/.exec(text);
  const withWord = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:dollars?|bucks|usd)\b/i.exec(text);
  const m = withSign ?? withWord;
  if (!m) return null;
  const whole = Number(m[1]!.replace(/,/g, ''));
  const frac = m[2] ? Number(m[2].padEnd(2, '0')) / 100 : 0;
  return dollarsToCents(whole + frac);
}

/**
 * Classifies one reply. 'yes' / 'no' are returned whether or not an approval is pending; the
 * router turns them into TEXT when nothing is waiting on them.
 */
export function parseReply(text: string, ctx: ReplyContext = {}): ParsedReply {
  if (ctx.billUnconfirmed) {
    const amount = findDollarAmount(text);
    if (amount !== null) return { kind: 'correction', amount };
  }
  const n = normalizeReply(text);
  if (YES.test(n)) return { kind: 'yes' };
  if (NO.test(n)) return { kind: 'no' };
  if (CHOICE.test(n)) {
    const choice = Number(n);
    if (ctx.choiceCount !== undefined && choice >= 1 && choice <= ctx.choiceCount) return { kind: 'choice', choice };
  }
  return { kind: 'text' };
}
