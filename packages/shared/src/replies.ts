/**
 * SPEC §5.1 reply parsing. Code, not a model: trim, lowercase, strip punctuation.
 * Order: a dollar-amount correction (only while the bill is unconfirmed), then yes/no, then a choice
 * (a number, an ordinal, or the option's own words). Anything else is TEXT; the server may ask a model
 * about a still-ambiguous reply, but only to map it onto the pending approval's choices.
 * Shared so the server, the demo script and the dashboard's demo mode classify replies the same way.
 */
import { dollarsToCents } from './format';
import type { Cents, OptionId } from './types';

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
  /**
   * Pending option_choice approval's optionIds, in the order texted. Lets "call them" or "savings"
   * mean the number of that option. Implies choiceCount when choiceCount is not given.
   */
  optionIds?: readonly OptionId[];
}

// ---------------------------------------------------------------------------
// Words people use. Everything below runs on normalizeReply() text: lowercase, no punctuation
// ("don't" -> "dont", "#1" -> "1").
// ---------------------------------------------------------------------------

const PLEASANTRY = 'please|pls|thanks|thank you|thx|ty';
const YES_WORD =
  'y|yes|yep|yeah|yea|yup|ya|yah|ok|okay|k|kk|sure|sure thing|absolutely|definitely|certainly|fine|alright|approve|approved|' +
  'sounds good|sounds great|looks good|go ahead|go for it|do it|lets do it|lets go|please do|thats right|thats correct|correct';
const NO_WORD =
  'n|no|nope|nah|nay|negative|dont|do not|stop|cancel|decline|declined|nevermind|never mind|not now|not yet';
const YES = new RegExp(`^(?:${YES_WORD})(?: (?:${YES_WORD}|${PLEASANTRY}|great|perfect|now))*$`);
const NO = new RegExp(`^(?:${NO_WORD})(?: (?:${NO_WORD}|${PLEASANTRY}|it|that|this|them|call|calling|do|do it|go ahead|now|yet|way))*$`);
const YES_EMOJI = /^[👍👌✅🙏💯]+$/u;
const NO_EMOJI = /^[👎❌🚫🛑]+$/u;
/** Skin tones, variation selectors and joiners that ride along with an emoji. */
const EMOJI_MODIFIERS = /[\u{1F3FB}-\u{1F3FF}\uFE0F\u200D\s]/gu;

const NUMBER_WORD: Record<string, number> = {
  '1': 1, one: 1, first: 1, '1st': 1,
  '2': 2, two: 2, second: 2, '2nd': 2,
  '3': 3, three: 3, third: 3, '3rd': 3,
  '4': 4, four: 4, fourth: 4, '4th': 4,
  '5': 5, five: 5, fifth: 5, '5th': 5,
  '6': 6, six: 6, sixth: 6, '6th': 6,
  '7': 7, seven: 7, seventh: 7, '7th': 7,
  '8': 8, eight: 8, eighth: 8, '8th': 8,
  '9': 9, nine: 9, ninth: 9, '9th': 9,
};
/** Words that may sit in front of the number ("do 1", "option 2", "ill take the second"). */
const LEAD_FILLER = new Set(['do', 'lets', 'ill', 'id', 'i', 'take', 'pick', 'choose', 'go', 'with', 'the', 'a', 'option', 'number', 'num', 'choice', 'no', 'pls', 'please']);
/** Words that may trail it ("the first one", "2 please"). */
const TAIL_FILLER = new Set(['one', 'option', 'choice', 'please', 'pls', 'thanks', 'thx', 'thank', 'you', 'ty']);
/** Extra words dropped before comparing against an option's own phrases ("call the lender please"). */
const PHRASE_FILLER = new Set([...[...LEAD_FILLER].filter((w) => w !== 'no'), ...TAIL_FILLER, 'my', 'your', 'me', 'to', 'for', 'just', 'that', 'this']);

/** What people say for each option, after PHRASE_FILLER words are dropped. */
const OPTION_PHRASES: Record<OptionId, readonly string[]> = {
  move_payment: ['call', 'call them', 'call lender', 'lender', 'ask lender', 'ask them', 'move payment', 'move car payment', 'push payment', 'move it', 'push it', 'ask lender move payment'],
  card: ['card', 'credit card', 'use card', 'use credit card', 'put it on card', 'put on card', 'put it on credit card', 'on card', 'charge it', 'pay with card'],
  savings: ['savings', 'use savings', 'from savings', 'savings account', 'take from savings', 'pull from savings', 'dip into savings'],
  cd_renew: ['renew', 'renew cd', 'renew it', 'rollover', 'roll over', 'roll it over', 'keep cd', 'keep it'],
  cd_payoff_card: ['card', 'pay off card', 'pay card', 'payoff', 'pay off', 'pay down card', 'pay off card with cd', 'use cd', 'cash out cd'],
};

/** How an option reads in a "did you mean" check (a template: no numbers). */
export const OPTION_NAMES: Record<OptionId, string> = {
  move_payment: 'calling your lender',
  card: 'putting it on your card',
  savings: 'using your savings',
  cd_renew: 'renewing the CD',
  cd_payoff_card: 'paying off the card',
};

function numberChoice(n: string): number | null {
  const tokens = n.split(' ');
  while (tokens.length > 1 && LEAD_FILLER.has(tokens[0]!)) tokens.shift();
  if (tokens.length === 1) return NUMBER_WORD[tokens[0]!] ?? null;
  while (tokens.length > 1 && TAIL_FILLER.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.length === 1 ? (NUMBER_WORD[tokens[0]!] ?? null) : null;
}

/** The one option whose own words match; null when none or more than one does. */
function labelChoice(n: string, optionIds: readonly OptionId[]): number | null {
  const phrase = n.split(' ').filter((t) => !PHRASE_FILLER.has(t)).join(' ');
  if (!phrase) return null;
  const hits = optionIds.flatMap((id, i) => (OPTION_PHRASES[id]?.includes(phrase) ? [i + 1] : []));
  return hits.length === 1 ? hits[0]! : null;
}

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
  if (!n) {
    const glyphs = text.replace(EMOJI_MODIFIERS, '');
    if (YES_EMOJI.test(glyphs)) return { kind: 'yes' };
    if (NO_EMOJI.test(glyphs)) return { kind: 'no' };
    return { kind: 'text' };
  }
  if (YES.test(n)) return { kind: 'yes' };
  if (NO.test(n)) return { kind: 'no' };
  const count = ctx.choiceCount ?? ctx.optionIds?.length;
  if (count !== undefined) {
    const choice = numberChoice(n) ?? (ctx.optionIds ? labelChoice(n, ctx.optionIds) : null);
    if (choice !== null && choice >= 1 && choice <= count) return { kind: 'choice', choice };
  }
  return { kind: 'text' };
}

// ---------------------------------------------------------------------------
// "Just to check" texts, for a reply that might mean something but is not sure enough to act on.
// Templates: no balances, limits or dollar amounts.
// ---------------------------------------------------------------------------

/** "Just to check, did you mean option 1, calling your lender? ..." */
export function clarifyChoiceText(choice: number, optionId: OptionId): string {
  return `Just to check, did you mean option ${choice}, ${OPTION_NAMES[optionId]}? Reply YES to go ahead, or send the number of the option you want.`;
}

/** The model could not tell which option was meant: ask for the number. */
export function clarifyWhichText(count: number): string {
  const nums = Array.from({ length: Math.max(count, 1) }, (_, i) => String(i + 1));
  const list = nums.length === 1 ? nums[0]! : `${nums.slice(0, -1).join(', ')} or ${nums[nums.length - 1]}`;
  return `Just to check, which option did you mean? Reply ${list}.`;
}

/** A yes/no approval (the call's limits, a lender's offer) that a fuzzy reply might have answered. */
export function clarifyYesNoText(kind: 'call_limits' | 'deal'): string {
  return kind === 'call_limits'
    ? 'Just to check, should I go ahead and make the call? Reply YES or NO.'
    : 'Just to check, should I accept that offer? Reply YES or NO.';
}
