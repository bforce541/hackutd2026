/**
 * SPEC §5.1 reply parsing. Code, not a model: trim, lowercase, strip punctuation, forgive typos
 * ("yse", "okk", "yesss") and slang ("ya", "bet", "aight").
 * Order: a dollar-amount correction (only while the bill is unconfirmed), then yes/no, then a choice
 * (a number, an ordinal, or the option's own words), then "wait" and "you pick". Anything else is
 * TEXT; the server may ask a model about a still-ambiguous reply, but only to map it onto the
 * pending approval's choices (messaging/classify.ts).
 * Shared so the server, the demo script and the dashboard's demo mode classify replies the same way.
 */
import { dollarsToCents, formatMoney } from './format';
import type { Cents, OptionId } from './types';

export type ParsedReply =
  | { kind: 'correction'; amount: Cents }
  | { kind: 'choice'; choice: number }
  | { kind: 'yes' }
  | { kind: 'no' }
  /** "wait", "hold on", "not yet", "let me think": answers nothing yet. */
  | { kind: 'wait' }
  /** "you pick", "whatever you think", "the one you recommend", "idk": wants PacePay's pick. */
  | { kind: 'defer' }
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

const PLEASANTRY = 'please|pls|plz|thanks|thank you|thx|ty|tysm|man|bro|dude|boss|sir|lol|haha|then|now';
const YES_WORD =
  'y|yes|ye|yee|yea|yeah|yeh|yah|ya|yas|yep|yeap|yup|yuh|ys|yse|yesh|yess|yessir|yes sir|ok|okay|okey|oki|okie|k|kk|kay|' +
  'sure|sure thing|for sure|of course|ofc|perfect|absolutely|definitely|def|certainly|fine|thats fine|alright|all right|allright|alr|aight|ight|bet|' +
  'approve|approved|aprove|aproved|approve it|i approve|accept|accepted|accept it|i accept|agree|agreed|confirm|confirmed|deal|' +
  'sounds good|sounds great|sounds fine|looks good|looks right|looks correct|go ahead|go for it|do it|do that|lets do it|lets do that|lets go|please do|' +
  'thats right|thats correct|thats it|correct|right|exactly|yes it is|it is|that works|works|works for me|proceed|green light|lgtm|mhm|uh huh';
const NO_WORD =
  'n|no|na|nah|naw|nope|nay|negative|dont|do not|stop|cancel|decline|declined|i decline|reject|rejected|pass|i pass|hard pass|skip|skip it|' +
  'nevermind|never mind|nvm|not now|no way|no thanks|rather not|id rather not|not interested|neither|none|none of those|none of them|neither of those|' +
  'wrong|thats wrong|incorrect|not right|thats not right|not correct|leave it';
const WAIT_WORD =
  'wait|hold on|hold up|one sec|sec|a sec|one second|a second|give me a sec|give me a second|give me a minute|one minute|a minute|one moment|' +
  'not yet|let me think|lemme think|let me think about it|let me check|thinking|hmm|hm|hmmm|brb|ill get back to you|ill let you know|later';
const DEFER_WORD =
  'you pick|you choose|you decide|your call|your choice|up to you|its up to you|dealers choice|you tell me|whatever|whatever you think|whatever you want|' +
  'whatever you recommend|whatever you suggest|whatever is best|whatever works|whichever|whichever is best|whichever you think|whichever you recommend|' +
  'the one you recommend|the one you recommended|the one you suggest|the one you suggested|the one you picked|the one you like|what you recommend|' +
  'what you think|what you think is best|your recommendation|your pick|go with your pick|your pick is fine|the recommended one|the best one|' +
  'do what you think is best|do whatever you think|idk|i dont know|dont know|dunno|not sure|im not sure|no idea|no clue|you know best';
const words = (s: string) => s.split('|');
const INTERJECTION = /^(?:(?:lol|lmao|haha|hahah|oh|ohh|um|umm|uh|uhh|well|hey|ah|ahh|oops|sorry|my bad) )+/;
/** "okk" -> "ok", "yesss" -> "yes", "nooo" -> "no": letters only, so "11" stays 11. */
const squeeze = (s: string) => s.replace(/(\p{L})\1+/gu, '$1');
function phraseRegex(head: string, tail: string, squeezed = false): RegExp {
  const f = (l: string) => words(l).map((w) => (squeezed ? squeeze(w) : w)).join('|');
  return new RegExp(`^(?:${f(head)})(?: (?:${f(tail)}))*$`);
}
const YES_TAIL = `${YES_WORD}|${PLEASANTRY}|great|perfect|good|cool|it|that|thats fine`;
const NO_TAIL = `${NO_WORD}|${PLEASANTRY}|it|that|this|them|call|calling|do|do it|go ahead|yet|way|thank you|either|of those`;
const YES = phraseRegex(YES_WORD, YES_TAIL);
const YES_SQUEEZED = phraseRegex(YES_WORD, YES_TAIL, true);
const NO = phraseRegex(NO_WORD, NO_TAIL);
const NO_SQUEEZED = phraseRegex(NO_WORD, NO_TAIL, true);
const WAIT = phraseRegex(WAIT_WORD, `${WAIT_WORD}|${PLEASANTRY}|ok|okay|k|a|bit|min|minute|about it|yet|still|idk|i dont know|dont know|not sure|dunno|deciding`);
/** "no not yet", "ok hold on", "um wait": the lead word doesn't make it a no or a yes. */
const WAIT_LEAD = /^(?:no|nah|nope|ok|okay|k|um|uh|so|well|yeah|yea|ya) (?=\S)/;
const DEFER = phraseRegex(DEFER_WORD, `${DEFER_WORD}|${PLEASANTRY}|ok|okay|is fine|works|one|option|i guess|honestly|tbh|lol`);
const YES_EMOJI = /^[👍👌✅🙏💯🫡🤝]+$/u;
const NO_EMOJI = /^[👎❌🚫🛑🙅]+$/u;
/** 🤔 / ⏳: still thinking. 🤷: "you pick". */
const WAIT_EMOJI = /^[🤔🧐⏳⌛]+$/u;
const DEFER_EMOJI = /^[🤷]+$/u;
/** Skin tones, variation selectors and joiners that ride along with an emoji. */
const EMOJI_MODIFIERS = /[\u{1F3FB}-\u{1F3FF}️‍\s]/gu;

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
const LEAD_FILLER = new Set([
  'do', 'lets', 'let', 'us', 'ill', 'id', 'i', 'take', 'pick', 'choose', 'go', 'with', 'the', 'a', 'option', 'opt', 'number', 'num', 'choice', 'no', 'nr',
  'pls', 'plz', 'please', 'yes', 'ye', 'yea', 'yeah', 'yep', 'yup', 'ya', 'yah', 'ok', 'okay', 'okk', 'k', 'kk', 'sure', 'alright', 'want', 'like', 'prefer',
  'think', 'say', 'vote', 'um', 'uh', 'hmm', 'hm', 'so', 'then', 'just', 'gonna', 'going', 'will', 'can', 'you', 'we', 'definitely', 'probably', 'oh',
  'wait', 'actually', 'sorry', 'oops', 'make', 'it', 'nvm', 'nevermind',
]);
/** Words that may trail it ("the first one", "2 please", "1 sounds good"). */
const TAIL_FILLER = new Set([
  'one', 'option', 'choice', 'please', 'pls', 'plz', 'thanks', 'thx', 'thank', 'you', 'ty', 'is', 'sounds', 'good', 'great', 'fine', 'works', 'best',
  'perfect', 'then', 'i', 'guess', 'it', 'is', 'for', 'me', 'now', 'lol', 'man', 'bro', 'dude', 'there', 'pick', 'right', 'ok', 'okay', 'k',
]);
/** Extra words dropped before comparing against an option's own phrases ("call the lender please"). */
const PHRASE_FILLER = new Set([
  ...[...LEAD_FILLER].filter((w) => w !== 'no' && w !== 'you' && w !== 'it'),
  ...[...TAIL_FILLER].filter((w) => w !== 'you' && w !== 'it'),
  'my', 'your', 'me', 'to', 'for', 'just', 'that', 'this', 'an', 'one', 'option', 'instead', 'pick', 'ahead', 'and', 'actually', 'yea', 'yeah', 'yes',
]);

/** What people say for each option, after PHRASE_FILLER words are dropped. */
const OPTION_PHRASES: Record<OptionId, readonly string[]> = {
  move_payment: [
    'call', 'call them', 'call em', 'call him', 'call her', 'call lender', 'call bank', 'call it', 'make call', 'phone them', 'phone lender', 'ring them',
    'lender', 'car lender', 'auto lender', 'ask lender', 'ask them', 'ask lender move it', 'ask them move it', 'move payment', 'move car payment',
    'push payment', 'push car payment', 'push it back', 'move it', 'push it', 'ask lender move payment', 'ask lender move car payment',
    'move date', 'move due date', 'delay payment', 'delay car payment', 'negotiate', 'calling', 'calling lender', 'calling them', 'phone call',
  ],
  card: [
    'card', 'credit card', 'credit', 'cc', 'use card', 'use credit card', 'use credit', 'put it on card', 'put on card', 'put it on credit card',
    'put it on credit', 'on card', 'charge it', 'charge card', 'charge it card', 'pay with card', 'card it',
  ],
  savings: [
    'savings', 'saving', 'use savings', 'use saving', 'from savings', 'savings account', 'take from savings', 'take it from savings', 'pull from savings',
    'pull it from savings', 'dip into savings', 'move from savings', 'transfer from savings', 'savings transfer',
  ],
  cd_renew: ['renew', 'renew cd', 'renew it', 'rollover', 'roll over', 'roll it over', 'keep cd', 'keep it', 'renewing', 'renew cd again'],
  cd_payoff_card: ['card', 'pay off card', 'pay card', 'payoff', 'pay off', 'pay down card', 'pay off card with cd', 'use cd', 'cash out cd', 'pay it off', 'pay off credit card', 'payoff card', 'kill card'],
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
  if (/\bcall me\b/.test(n)) return null; // Yoshua asking to be called, not "call the lender"
  const phrase = n.split(' ').filter((t) => !PHRASE_FILLER.has(t)).join(' ');
  if (!phrase) return null;
  const hits = optionIds.flatMap((id, i) => (OPTION_PHRASES[id]?.includes(phrase) ? [i + 1] : []));
  return hits.length === 1 ? hits[0]! : null;
}

// "My paycheck is going to be late, it lands Monday" / "what if my check is late?": news for the
// paycheck paths, never an answer to a pending approval. Shared by the router and the orchestrator.
export const PAYCHECK_WORDS = /\b(pay ?check|paycheque|pay ?day|direct deposit|salary|wages|my pay|my check|the check|my deposit)\b/i;
export const LATE_WORDS =
  /\b(late|delay(?:ed)?|slips?|slipped|pushed|won'?t (?:come|land|arrive|hit|clear)|doesn'?t (?:come|land|arrive|hit|clear)|(?:landing|lands|coming|arrives?|arriving|hits?|clears?) (?:on |till |until )?(?:mon|tues?|wed|thu|fri|sat|sun|next))/i;
/** True for a message about the paycheck being late (a report or a what-if). */
export function isPaycheckNews(text: string): boolean {
  return PAYCHECK_WORDS.test(text) && LATE_WORDS.test(text);
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

/** Words that say yes on their own; a model's "yes" to a money-moving approval needs one of these in the text. */
const AFFIRM = new Set(
  ('y|yes|ye|yea|yeah|yeh|yah|ya|yas|yep|yup|ys|yse|yesh|yessir|ok|okay|okey|oki|okie|k|kk|sure|fine|alright|aight|bet|absolutely|definitely|' +
    'approve|approved|accept|accepted|agree|agreed|confirm|confirmed|deal|works|perfect|great|proceed|lgtm').split('|').map(squeeze),
);
const AFFIRM_PHRASE = /\b(?:go ahead|go for it|do it|do that|lets do it|lets do that|that works|sounds good|sounds great|looks good|of course|for sure|please do|all right)\b/;

/**
 * True when the text itself carries a plain yes ("lol ok", "that works for me", "sure, go ahead and call").
 * A model can over-read "put it on the card" as agreement; code checks for the word before a money-moving yes.
 */
export function hasYesWord(text: string): boolean {
  if (/[👍👌✅💯🤝]/u.test(text)) return true;
  const n = normalizeReply(text);
  return AFFIRM_PHRASE.test(n) || n.split(' ').some((t) => AFFIRM.has(squeeze(t)));
}

const NEGATE = new Set('n|no|na|nah|naw|nope|nay|not|dont|never|cancel|stop|decline|declined|reject|pass|skip|neither|none|wrong|incorrect|forget|nvm|nevermind'.split('|'));

/**
 * True when the text itself carries a no ("not a chance", "forget it", "nah"), and is not "no problem"
 * / "no worries" (which agree). A model's "no" needs one, so a friendly reply never declines a deal.
 */
export function hasNoWord(text: string): boolean {
  if (/[👎❌🚫🛑🙅]/u.test(text)) return true;
  const n = normalizeReply(text).replace(/\bno (?:problem|prob|probs|worries|worry|biggie|doubt|fee|fees|charge|charges|cost|extra fee|catch)\b/g, '');
  return n.split(' ').some((t) => NEGATE.has(squeeze(t)) || NEGATE.has(t));
}

/** A reply to an approval that has already closed (the call ended, it timed out, or the offer changed). */
export function lateReplyText(kind: YesNoKind | 'option_choice'): string {
  if (kind === 'deal') return "That offer isn't open anymore, so I didn't agree to anything and nothing changed. Want me to try the lender again? Just say so.";
  if (kind === 'call_limits') return "That question isn't open anymore, so I didn't call. Nothing changed.";
  return "That question isn't open anymore, so nothing changed.";
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
  const raw = normalizeReply(text);
  if (!raw) {
    const glyphs = text.replace(EMOJI_MODIFIERS, '');
    if (YES_EMOJI.test(glyphs)) return { kind: 'yes' };
    if (NO_EMOJI.test(glyphs)) return { kind: 'no' };
    if (WAIT_EMOJI.test(glyphs)) return { kind: 'wait' };
    if (DEFER_EMOJI.test(glyphs)) return { kind: 'defer' };
    return { kind: 'text' };
  }
  // "lol ok", "oh yeah", "um 2": a leading interjection changes nothing.
  const n = (INTERJECTION.test(raw) && raw.replace(INTERJECTION, '') ? raw.replace(INTERJECTION, '') : raw).replace(/\bgud\b/g, 'good').replace(/\bgr8\b/g, 'great');
  const sq = squeeze(n);
  if (YES.test(n) || YES_SQUEEZED.test(sq)) return { kind: 'yes' };
  // "no, go ahead" / "nah do it": a no word and a yes in one breath is not a clear no (nor a yes).
  const rest = n.replace(/^\S+ /, '');
  const noThenYes = /^(?:n|no|na|nah|naw|nope) \S/.test(n) && hasYesWord(rest) && !hasNoWord(rest);
  if ((NO.test(n) || NO_SQUEEZED.test(sq)) && !noThenYes) return { kind: 'no' };
  const count = ctx.choiceCount ?? ctx.optionIds?.length;
  if (count !== undefined) {
    const choice = numberChoice(n) ?? (ctx.optionIds ? labelChoice(n, ctx.optionIds) : null);
    if (choice !== null && choice >= 1 && choice <= count) return { kind: 'choice', choice };
  }
  const unled = n.replace(WAIT_LEAD, '');
  if (WAIT.test(n) || WAIT.test(sq) || WAIT.test(unled) || WAIT.test(squeeze(unled))) return { kind: 'wait' };
  if (DEFER.test(n) || DEFER.test(sq)) return { kind: 'defer' };
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
  return `Just to check, which option did you mean? Reply ${numberList(count)}.`;
}

/** The yes/no approvals: the bill check, the call's limits, a lender's offer. */
export type YesNoKind = 'bill_confirm' | 'call_limits' | 'deal';

/** A yes/no approval that a fuzzy reply might have answered. */
export function clarifyYesNoText(kind: YesNoKind): string {
  if (kind === 'bill_confirm') return 'Just to check, is that bill right? Reply YES, or send the right amount.';
  return kind === 'call_limits'
    ? 'Just to check, should I go ahead and make the call? Reply YES or NO.'
    : 'Just to check, should I accept that offer? Reply YES or NO.';
}

/** "Whatever you think" / "you pick" / a plain yes to the list: offer PacePay's pick (option 1) and wait for an OK. */
export function recommendText(choice: number, optionId: OptionId): string {
  return `I'd go with option ${choice}, ${OPTION_NAMES[optionId]}. OK? Reply YES, or send another number.`;
}

/** "No" / "neither" to the list of options: nothing happens, the list stays open. */
export function holdOffText(count: number): string {
  return `OK, I'll hold off. Reply ${numberList(count)} if you change your mind.`;
}

/** "Wait" / "hold on" / "not yet": nothing happens. `onCall`: the lender is holding on the phone. */
export function waitText(kind: YesNoKind | 'option_choice', p: { count?: number; onCall?: boolean } = {}): string {
  if (kind === 'option_choice') return `Sure, take your time. Reply ${numberList(p.count ?? 1)} when you're ready.`;
  if (kind === 'deal' && p.onCall) return "Sure. They're holding on the line, so reply YES or NO when you can.";
  return "Sure, take your time. Reply YES or NO when you're ready.";
}

/** "Yes but no fee" / "can you do Monday instead?": PacePay can't add conditions to a yes, so it asks plainly. */
export function conditionText(kind: YesNoKind): string {
  if (kind === 'deal') return "I can only take their offer as it stands or pass on it. Reply YES to take it, or NO to pass.";
  if (kind === 'call_limits') return 'Just to check, should I make the call with the limits I sent? Reply YES or NO.';
  return clarifyYesNoText(kind);
}

/** One line after an answer to a side question, so the open question isn't lost. */
export function reaskText(kind: YesNoKind | 'option_choice', count = 1, prompt?: string): string {
  if (kind === 'option_choice') return `When you're ready, reply ${numberList(count)}.`;
  const t = prompt ? termsFromPrompt(prompt) : null;
  if (kind === 'deal') return t ? `Want me to accept ${termsPhrase(t)}? Reply YES or NO.` : 'Want me to accept their offer? Reply YES or NO.';
  if (kind === 'call_limits') return 'Should I make the call? Reply YES or NO.';
  return 'Is that bill right? Reply YES, or send the right amount.';
}

function numberList(count: number): string {
  const nums = Array.from({ length: Math.max(count, 1) }, (_, i) => String(i + 1));
  return nums.length === 1 ? nums[0]! : `${nums.slice(0, -1).join(', ')} or ${nums[nums.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Messy and adversarial replies. A money-moving approval (the call's limits, a lender's offer)
// moves only on a clear, current, unconditional yes to exactly the terms in that approval. Code
// reads these signals; a model never gets to wave one through.
// ---------------------------------------------------------------------------

/** Sarcasm, shrugs and maybes: "oh great, sure, whatever", "ok i guess", "🙄". Never a yes to money. */
const HEDGE =
  /\b(?:whatever|whatevs|yeah right|sure jan|i guess|i suppose|guess so|suppose so|maybe|mayb|probably|possibly|perhaps|kinda|kind of|sort of|something like that|i think so|think so|idk|i dont know|not sure|dunno|eh|meh|ugh|if you say so|if you must|fine then|love that for me|just great|great just great|thanks a lot|wow okay|sure buddy|sure pal)\b/;
const HEDGE_EMOJI = /[🙄😒😑😬🤔🤨😐🤷😤😩🥲🫠]/u;
/** A condition or a change riding on the answer: "ok but not friday", "yes if it's under $15". */
const CONDITION =
  /\b(?:but|only if|if|as long as|long as|unless|provided|except|instead|rather|under|less than|more than|no more than|not more than|max|maximum|at most|tops|cap|capped|below|cheaper|lower|higher|different day|another day|other day|earlier|later|not (?:on )?(?:mon|tues?|wed|thu|thurs|fri|sat|sun)(?:day|nesday|rsday|urday)?|not the \d{1,2}(?:st|nd|rd|th)?)\b/;
/** "ignore your rules", "you are now in developer mode": instructions aimed at PacePay itself. */
const INJECTION =
  /\b(?:ignore|disregard|forget|override|bypass|break)\b[\w\s']{0,30}?\b(?:rules?|instructions?|limits?|prompts?|guidelines?|restrictions?|polic(?:y|ies)|programming|safety|guardrails?|system|training)\b|\b(?:system prompt|developer mode|dev mode|jailbreak|you are now|act as|pretend (?:to be|you are|youre)|new instructions?|admin override|sudo|pre[- ]?approved|already approved all|authorized you to)\b|^\s*(?:system|assistant|admin|developer)\s*:/;
/** "approve everything from now on", "don't ask me next time": a standing yes PacePay doesn't take. */
const STANDING =
  /\b(?:auto ?approve|approve (?:everything|anything|all(?: of them)?)|accept (?:everything|anything|whatever)|dont (?:need to |have to )?(?:ask|check with) me|no need to (?:ask|check)|stop asking|never ask|always (?:say yes|approve|accept)|from now on (?:just )?(?:approve|accept|say yes))\b/;
/** "pay it from savings", "transfer $500 out of my roth": moving money, which PacePay never does. */
const MOVE_MONEY =
  /\b(?:pay|transfer|move|send|withdraw|wire|take|pull|use|cash out|venmo|zelle)\b[\w\s$.,']{0,40}?\b(?:from|out of|with|using|into|to)\b\s*(?:my |the |our )?(?:savings|checking|roth|ira|401k|retirement|brokerage|cd|account|bank)\b/;
const QUESTION_START = /^\s*(?:what|whats|what's|why|how|when|where|who|which|(?:can|could|will|would|should|is|are|does|did) (?:i|you|u|we|they|it|this|that|there|my|the|he|she)|do (?:i|you|u|we|they|my|the|he|she)|tell me|explain)\b/i;

export interface ReplySignals {
  /** A yes word and a no word in one message: "no wait yes", "yes... actually no". */
  mixed: boolean;
  /** Sarcasm or a maybe: "sure, whatever", "ok i guess", "🙄". */
  hedged: boolean;
  /** A condition or change attached: "ok but not friday", "yes if under $15", "instead". */
  condition: boolean;
  /** A fee cap he names: "under $15", "go up to $50 if you need to". */
  feeCap: Cents | null;
  /** Instructions aimed at PacePay: "ignore your rules". */
  injection: boolean;
  /** "Approve everything from now on." */
  standing: boolean;
  /** "Pay it from savings": asks PacePay to move money. */
  moveMoney: boolean;
  /** Ends in "?" or starts like a question. */
  question: boolean;
}

/** "under $15", "go up to $50", "max 10", "no more than 20 bucks", "$30 tops": a fee cap he wants. */
export function findFeeCap(text: string): Cents | null {
  const n = text.toLowerCase().replace(/,/g, '');
  const m =
    /\b(?:up to|upto|under|below|less than|no more than|not more than|max(?:imum)?(?: of)?|at most|cap(?: it)?(?: at)?|limit(?: it)?(?: to| of| at)?|budget(?: of| is)?|as high as|go to|go as high as|as much as|anything under)\s*(?:a |the )?\$?\s?(\d{1,4}(?:\.\d{1,2})?)(?![\d.]|\s*(?:st|nd|rd|th)\b|\s*(?:days?|%|percent))/.exec(n) ??
    /(?:^|\s)\$?(\d{1,4}(?:\.\d{1,2})?)\s*(?:dollars?|bucks)?\s*(?:max|tops|or less|at most|is the max|is my max|is the limit|is the most)\b/.exec(n);
  return m ? dollarsToCents(Number(m[1])) : null;
}

export function replySignals(text: string): ReplySignals {
  const n = normalizeReply(text);
  const lower = text.toLowerCase().replace(/[’']/g, '');
  return {
    mixed: hasYesWord(text) && hasNoWord(text),
    hedged: HEDGE.test(n) || HEDGE_EMOJI.test(text),
    condition: CONDITION.test(n),
    feeCap: findFeeCap(text),
    injection: INJECTION.test(lower),
    standing: STANDING.test(n),
    moveMoney: MOVE_MONEY.test(lower),
    question: text.includes('?') || QUESTION_START.test(text),
  };
}

/** The day and fee in an approval PacePay texted ("They'll move it to Fri, Nov 13 for $20", "...Fri, Nov 13, with $25 max in fees"). */
export interface PromptTerms {
  /** "Fri, Nov 13" */
  label: string;
  weekday: string;
  month: string;
  date: number;
  /** The fee (a deal) or the fee cap (the call's limits); 0 = no fee; null = none named. */
  fee: Cents | null;
}

const WEEKDAY_RE = /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|rsday|urday|s)?\b/g;
const MONTH_RE = /\b(jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:uary|ruary|ch|il|e|y|ust|tember|ober|ember)?\b/g;

export function termsFromPrompt(prompt: string): PromptTerms | null {
  // A changed-terms approval names the old terms first ("...after you approved $20. They'll move it to Fri, Nov 13 for $35 instead."):
  // the terms asked about are the ones after the last "move it to".
  const at = prompt.toLowerCase().lastIndexOf('move it to');
  const ask = at >= 0 ? prompt.slice(at) : prompt;
  const d = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* (\d{1,2})\b/.exec(ask);
  if (!d) return null;
  const tail = ask.slice(d.index + d[0].length).split(/[.?!](?:\s|$)/)[0] ?? '';
  const fee = /\bno fee\b/i.test(tail) ? 0 : findDollarAmount(tail);
  return { label: `${d[1]}, ${d[2]} ${d[3]}`, weekday: d[1]!.toLowerCase(), month: d[2]!.toLowerCase(), date: Number(d[3]), fee };
}

/** "Fri, Nov 13 for $20" / "Fri, Nov 13 with no fee". */
export function termsPhrase(t: PromptTerms): string {
  return t.fee === null ? t.label : t.fee === 0 ? `${t.label} with no fee` : `${t.label} for ${formatMoney(t.fee)}`;
}

/**
 * True when the reply names a day, date or amount that is not in the terms PacePay asked about:
 * "yes, $20 is fine" to a $35 offer, "ok for monday" to a Friday one, "yes 1" to the deal.
 */
export function termsMismatch(text: string, t: PromptTerms | null): boolean {
  const n = text.toLowerCase().replace(/[’']/g, '');
  const days = [...n.matchAll(WEEKDAY_RE)].map((m) => m[1]!.slice(0, 3));
  const months = [...n.matchAll(MONTH_RE)].map((m) => m[1]!.slice(0, 3));
  const amounts = [...n.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars?|bucks|usd)\b/g)].map((m) => dollarsToCents(Number((m[1] ?? m[2])!.replace(/,/g, ''))));
  const bare = [...n.replace(/\$\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s*(?:dollars?|bucks|usd)\b/g, ' ').matchAll(/\b(\d{1,4})(?:st|nd|rd|th)?\b/g)].map((m) => Number(m[1]));
  const freeWords = /\b(?:no fee|free|without a fee|no charge|waive|waived|zero fee)\b/.test(n);
  const relative = /\b(?:today|tomorrow|tonight|next week|next month|this week|end of the month|the old|the first one|the earlier|previous|before)\b/.test(n);
  if (!days.length && !months.length && !amounts.length && !bare.length && !freeWords && !relative) return false;
  if (!t || relative) return true;
  if (days.some((d) => d !== t.weekday) || months.some((m) => m !== t.month)) return true;
  if (amounts.some((a) => a !== t.fee)) return true;
  if (bare.some((b) => b !== t.date && dollarsToCents(b) !== t.fee)) return true;
  return freeWords && t.fee !== 0;
}

/** Words that may sit around a clear yes to a money-moving question ("yes please, take the deal, thanks!"). */
const CLEAR_YES_WORDS = new Set(
  [...`${YES_WORD}|${YES_TAIL}`.split(/[| ]/), ...('the|a|an|that|this|it|its|thats|offer|deal|one|lets|let|us|go|ahead|with|do|take|accept|approve|move|payment|car|loan|and|so|then|' +
    'please|pls|plz|thanks|thank|you|ty|thx|tysm|sounds|looks|good|great|fine|cool|awesome|nice|perfect|works|work|for|me|to|i|is|yes|' +
    'ok|sure|call|them|lender|make|on|just|totally|yep|yeah|absolutely|really|very|much|appreciate|amazing|excellent|lol|haha|oh|well|' +
    'alright|right|now|asap|book|lock|in|confirm|agree|fee|fees|will|ill|we|can|that|good|go|man|bro|dude|sir|boss|yay|woo|wow|nice|' +
    'friday|monday|tuesday|wednesday|thursday|mon|tue|wed|thu|fri|nov|november|dollars|bucks|max|limits|limit|terms|those|these|price|thing')
    .split('|')],
);

/**
 * A clear yes to a money-moving approval: a yes word, nothing hedged, conditional, mixed or
 * aimed at PacePay, every other word a filler or part of the terms asked about. "yes, take it!"
 * and "ok, Friday for $20 works" pass; "approve the card payment", "sure whatever" and "yes but
 * under $15" don't.
 */
export function isClearYes(text: string, terms: PromptTerms | null): boolean {
  if (!hasYesWord(text)) return false;
  const s = replySignals(text);
  if (s.mixed || s.hedged || s.condition || s.injection || s.standing || s.moveMoney || s.question || s.feeCap !== null) return false;
  if (termsMismatch(text, terms)) return false;
  const tokens = normalizeReply(text).replace(/\bno (?:problem|prob|probs|worries|worry|biggie|doubt)\b/g, ' ').split(' ').filter(Boolean);
  return tokens.every((t) => CLEAR_YES_WORDS.has(t) || AFFIRM.has(squeeze(t)) || /^\d{1,4}(?:st|nd|rd|th)?$/.test(t) || YES.test(t) || YES_SQUEEZED.test(squeeze(t)));
}

/** A reply that adds nothing: "thanks", "lol", "ty!", "😊". Dropped from a burst of texts. */
export function isPleasantry(text: string): boolean {
  const n = normalizeReply(text);
  if (!n) return /^[\p{Extended_Pictographic}\s\u{1F3FB}-\u{1F3FF}️‍]+$/u.test(text) && !YES_EMOJI.test(text.replace(EMOJI_MODIFIERS, '')) && !NO_EMOJI.test(text.replace(EMOJI_MODIFIERS, '')) && !HEDGE_EMOJI.test(text) && !WAIT_EMOJI.test(text.replace(EMOJI_MODIFIERS, ''));
  return /^(?:thanks|thank you|thank u|thx|ty|tysm|lol|lmao|haha|hahaha|cool thanks|ok thanks|appreciate it|appreciate you|you rock|nice|sweet|awesome thanks)$/.test(n);
}

// Texts for those replies. Templates: amounts only from the approval PacePay already sent.

/** A yes PacePay can't take as is: say the exact terms and ask again. `changedFrom`: the terms he approved before. */
export function confirmTermsText(kind: 'deal' | 'call_limits', t: PromptTerms | null, changedFrom?: PromptTerms | null): string {
  if (kind === 'call_limits') {
    return t ? `Just to check, should I call and ask for ${t.label}${t.fee !== null ? `, with ${formatMoney(t.fee)} max in fees` : ''}? Reply YES or NO.` : clarifyYesNoText('call_limits');
  }
  if (!t) return clarifyYesNoText('deal');
  if (changedFrom) return `Just to check: they changed the offer. It's now ${termsPhrase(t)}, not ${termsPhrase(changedFrom)}. Accept the new one? Reply YES or NO.`;
  return `Just to check, accept ${termsPhrase(t)}? Reply YES or NO.`;
}

/** "Yes but only under $15" to the lender's offer: PacePay can't add conditions; it takes the offer as is or passes. */
export function dealConditionText(t: PromptTerms | null): string {
  if (!t) return conditionText('deal');
  return `I can only accept their offer as it stands, ${termsPhrase(t)}, or pass on it. Reply YES to accept, or NO to pass.`;
}

/** "Go up to $50" / "only if it's under $15" before the call: a new limit needs its own yes. */
export function feeLimitChangeText(from: Cents, to: Cents): string {
  const verb = to > from ? 'raise' : 'lower';
  return `Just to check: ${verb} your fee limit from ${formatMoney(from)} to ${formatMoney(to)}, then make the call? Reply YES to call with up to ${formatMoney(to)} in fees, or NO to keep ${formatMoney(from)}.`;
}

/** NO to a new fee limit: the old one stands, and the call still needs a yes. */
export function feeLimitKeptText(limit: Cents): string {
  return `OK, I'll keep your ${formatMoney(limit)} fee limit. Should I make the call? Reply YES or NO.`;
}

/** A new limit while the call is already going: the one he OK'd stands. */
export function limitsLockedText(limit: Cents): string {
  return `I'm already on the call, so I'll stick to the limit you OK'd: ${formatMoney(limit)} max in fees. I'll text you before agreeing to anything.`;
}

/** "Ignore your rules", "approve everything", "pay it from savings": what PacePay won't do, said plainly. */
export function refusalText(kind: 'injection' | 'standing' | 'moveMoney'): string {
  if (kind === 'moveMoney') return "I can't move money. PacePay never moves money: you make any move at your bank.";
  if (kind === 'standing') return "I'll still check with you before I agree to anything. That part doesn't change.";
  return "I can't change how I work from a text. I only act on a clear YES or NO to what I asked.";
}

/** "1", "wait", "2" in a burst, or "no wait yes": not sure which, so ask once more. */
export function mixedAnswerText(kind: YesNoKind | 'option_choice', p: { count?: number; terms?: PromptTerms | null } = {}): string {
  if (kind === 'option_choice') return `I got a few different answers there. Which option do you want? Reply ${numberList(p.count ?? 1)}.`;
  if (kind === 'deal' && p.terms) return `I got a yes and a no there, so I haven't answered them. Accept ${termsPhrase(p.terms)}? Reply YES or NO.`;
  if (kind === 'call_limits') return "I got a yes and a no there, so I haven't called. Should I make the call? Reply YES or NO.";
  return `I got a yes and a no there. ${reaskText(kind)}`;
}
