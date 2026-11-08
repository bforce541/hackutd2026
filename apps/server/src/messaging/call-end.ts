/**
 * How a call with the lender ended, read in code from the call's transcript, for the honest text
 * Yoshua gets afterwards (tools/post_call_summary.ts) and for whether the "other ways to cover it"
 * text follows (orchestrator). The voice worker only reports "ended"; the words on the line say why:
 * a phone menu or queue, a voicemail (full or not), dead air, a long call that went nowhere, or a
 * lender that said it already processed a change and gave a reference. Never a model.
 */
import type { TranscriptLine } from '@pacepay/shared';

export type CallEndKind = 'lender_processed' | 'voicemail' | 'after_hours' | 'queue' | 'ivr' | 'dead_air' | 'long' | 'hangup';

export interface CallEndRead {
  kind: CallEndKind;
  /** The last reference / confirmation number the lender said, if any. */
  reference?: string;
  /** voicemail: PacePay spoke after the greeting and the mailbox took messages. */
  leftMessage?: boolean;
  /** voicemail: the mailbox was full. */
  mailboxFull?: boolean;
  /** The lender's actionable next steps, in short plain words (at most two). */
  nextSteps: string[];
  /** after_hours: their hours; queue: the wait they announced. */
  detail?: string;
  /** The lender said it would make the change ("I'll go ahead and make that change"), without confirming it was done. */
  lenderWill?: boolean;
  /** PacePay said the last words (it closed the call), so the lender didn't hang up on it. */
  pacepayClosed?: boolean;
  /** The lender stopped answering and PacePay ended the call. */
  wentQuiet?: boolean;
}

const VOICEMAIL = /\b(?:leave (?:a |your |me a )?(?:detailed )?(?:message|name)|after the (?:beep|tone)|voice ?mail|mailbox|not available to take your call|can'?t take your call|cannot take your call|away from my desk|unable to answer|record your message)\b/i;
const MAILBOX_FULL = /\bmailbox (?:is )?full\b|\bcannot accept (?:any )?(?:new |more )?messages\b|\bnot accepting messages\b/i;
const AFTER_HOURS = /\b(?:(?:offices?|we) (?:are|is) (?:currently )?closed|currently closed|our (?:business |office )?hours are|outside (?:of )?(?:our )?(?:normal )?business hours|business hours are)\b/i;
const QUEUE = /\b(?:estimated (?:wait|hold) time|next available (?:agent|representative)|all of our (?:agents|representatives)|assisting other (?:customers|callers)|place in (?:line|the queue)|in the queue|your call (?:is|will be) answered in the order|calls are being answered)\b/i;
const IVR = /\b(?:press (?:\d|one|two|three|four|five|star|pound)|para espa[nñ]ol|say (?:agent|representative|operator)|main menu|please (?:say|enter) your|enter your (?:account|loan)|your call is important)\b/i;
/** The lender says the change is already made (not "I can" / "I could" / "would"). */
const PROCESSED =
  /\b(?:(?:has|have) been (?:processed|updated|moved|changed|rescheduled|completed|submitted)|i(?:'ve| have) (?:updated|moved|changed|processed|rescheduled|made the change|made that change|gone ahead)|went ahead and (?:moved|changed|updated|processed|made|rescheduled)|you'?re all set|you are all set|payment (?:has been |is )?moved|updated it on (?:your|the) account|processed the change|change (?:has been|is) (?:processed|made|done|complete|in)|(?:will )?now be due on|is now (?:due|scheduled|set) (?:on|for))\b/i;
/** With a reference in the same breath, softer words also mean it's done: "Confirming now. Your reference number is 88421. All set." */
const PROCESSED_WITH_REF = /\b(?:all set|confirming (?:it |that )?now|confirmed|it'?s done|that'?s done|taken care of|moved it|i'?ll (?:go ahead and )?(?:make|process) (?:that|the) change)\b/i;
/** "Your reference number for this update is 884291", "Ref HG-2288", "confirmation number: LSF-2026-8842". */
const REFERENCE = /\b(?:reference|confirmation|ref|case|ticket)\b[^.?!\d]{0,40}?\b((?:[A-Z]{1,4}-?){0,4}\d[\dA-Z-]{2,})\b/gi;

/** The lender's next steps worth passing on to Yoshua: [pattern, plain words]. Order is priority. */
const NEXT_STEPS: [RegExp, (m: RegExpExecArray, all: string) => string][] = [
  [
    /\b(?:third[- ]party )?authori[sz]ation form|\bsigned (?:authori[sz]ation|consent)|\bpower of attorney\b/i,
    (_m, all) => `they need a signed third-party authorization form from you${/\bfax\b/i.test(all) ? /\bupload\b/i.test(all) ? ' (fax or upload)' : ' (by fax)' : /\bupload|portal\b/i.test(all) ? ' (upload it online)' : ''}${/\b(?:three|3) to (?:five|5) business days\b/i.test(all) ? ', which takes 3 to 5 business days' : ''}`,
  ],
  [/\b(?:add|list|set up)\b[^.?!]{0,50}\bauthori[sz]ed (?:user|party|contact|third party|representative)\b/i, () => 'you can add an authorized party in their app or online account'],
  [/\bthree[- ]way (?:call|conference)|\bconference (?:him|them|yoshua|the customer) in\b|\b(?:get|have|put) (?:yoshua|him|the (?:customer|account holder)) on the line\b/i, () => 'they can do a three-way call with you on the line'],
  [/\b(?:deferr?al|defer (?:the|this|your|a) payment|skip[- ]a[- ]pay)\b/i, () => 'they offer a payment deferral'],
  [
    /\b(?:no late fee|before a late fee|without a late fee|grace period)\b[^.?!]{0,50}?\b(?:the )?(\d{1,2})(?:st|nd|rd|th)\b|\buntil the (\d{1,2})(?:st|nd|rd|th)\b[^.?!]{0,40}\blate fee\b/i,
    (m) => `there's no late fee until the ${ordinal(Number(m[1] ?? m[2]))}`,
  ],
  [/\b(?:only|have to|has to|must|need to|needs to)\b[^.?!]{0,40}\b(?:online|website|web site|mobile app|our app|the app|portal)\b|\b(?:online|website|app|portal) only\b/i, () => 'changes have to be made online or in their app'],
  [
    /\bsupervisor\b[^.?!]{0,60}\bcall\b|\bcall (?:you|him|yoshua) back\b|\bcallback\b|\bcall back (?:within|in|tomorrow|between|later)\b/i,
    (_m, all) => {
      const between = /\b(tomorrow |today |monday |tuesday |wednesday |thursday |friday )?(?:morning )?between ((?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon)(?::\d\d)?(?: ?[ap]\.?m\.?)?) and ((?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon)(?::\d\d)?(?: ?[ap]\.?m\.?)?)/i.exec(all);
      if (between) return `they can call back ${between[1] ?? ''}between ${between[2]} and ${between[3]}`.replace(/\s+/g, ' ');
      const w = /\bwithin (?:the next )?(\d+|one|two|twenty[- ]four|forty[- ]eight) (hours?|business days?|days?)\b/i.exec(all) ?? /\b(tomorrow)\b/i.exec(all);
      return `they can call back${w ? (w[2] ? ` within ${w[1]} ${w[2]}` : ' tomorrow') : ''}`;
    },
  ],
  [
    /\b(?:yoshua|he|the (?:customer|account holder|borrower))\b[^.?!]{0,30}\b(?:call|contact) us(?: directly)?\b|\bhave (?:him|yoshua) call\b|\b(?:yoshua|he)(?:'ll| will)? (?:need|needs) to call\b/i,
    (_m, all) => {
      const by = /\bcall(?: us)?(?: back)? (before|by) ((?:mon|tues|wednes|thurs|fri|satur|sun)day(?: the \d{1,2}(?:st|nd|rd|th))?)/i.exec(all);
      return `they want you to call them directly${by ? ` ${by[1]!.toLowerCase()} ${by[2]}` : ''}`;
    },
  ],
];

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}

/** The last reference number the lender said (lender lines only; PacePay asking "reference number?" isn't one). */
export function findReference(lines: readonly string[]): string | undefined {
  let ref: string | undefined;
  for (const l of lines) {
    for (const m of l.matchAll(REFERENCE)) {
      if (!/\d{3,}/.test(m[1]!.replace(/-/g, ''))) continue;
      // Spelled out one character at a time ("L-S-7-7-2-0-4"): one token, "LS77204".
      ref = /^(?:[A-Z0-9]-){2,}[A-Z0-9]$/i.test(m[1]!) ? m[1]!.replace(/-/g, '').toUpperCase() : m[1]!.toUpperCase();
    }
  }
  return ref;
}

/** The lender's next steps (at most two), from its lines. */
export function lenderNextSteps(lines: readonly string[]): string[] {
  const all = lines.join(' ');
  const out: string[] = [];
  for (const [re, say] of NEXT_STEPS) {
    const m = re.exec(all);
    const note = m ? say(m, all) : null;
    // "add you as an authorized party in the app" is one step, not also "online only".
    if (note && !(note.startsWith('changes have to be made online') && out.some((o) => o.includes('authorized party')))) out.push(note);
    if (out.length >= 2) break;
  }
  return out;
}

export function readCallEnd(transcript: readonly TranscriptLine[] | undefined): CallEndRead {
  const t = transcript ?? [];
  const lender = t.filter((l) => l.speaker === 'counterparty' && l.text.trim().length > 1);
  const texts = lender.map((l) => l.text);
  const reference = findReference(texts);
  const nextSteps = lenderNextSteps(texts);
  const lenderWill = texts.some((x) => /\bi'?ll (?:go ahead and |just )?(?:make|process|put through|submit) (?:that|the|this) (?:change|update)|\bi'?ll (?:go ahead and )?(?:move|reschedule) (?:it|that|the payment)\b/i.test(x));
  const base = { ...(reference ? { reference } : {}), nextSteps, ...(lenderWill ? { lenderWill } : {}) };
  if (!lender.length) return { kind: 'dead_air', ...base };
  const all = texts.join(' ');
  if (texts.some((x) => PROCESSED.test(x) || (PROCESSED_WITH_REF.test(x) && !!findReference([x])))) return { kind: 'lender_processed', ...base };
  const vmAt = t.findIndex((l) => l.speaker === 'counterparty' && VOICEMAIL.test(l.text));
  const afterHours = AFTER_HOURS.test(all);
  if (vmAt >= 0 && !afterHours) {
    const mailboxFull = MAILBOX_FULL.test(all);
    const spokeAfter = t.slice(vmAt + 1).some((l) => l.speaker === 'pacepay' && l.text.trim().length > 20);
    return { kind: 'voicemail', mailboxFull, leftMessage: spokeAfter && !mailboxFull, ...base };
  }
  if (afterHours) {
    const hours = /\bour (?:business |office )?hours are ([^.]{5,90})/i.exec(all)?.[1]?.trim();
    return { kind: 'after_hours', ...base, ...(hours ? { detail: hours } : {}) };
  }
  // Every lender line is a recording (queue or menu): never reached a person.
  const recorded = lender.every((l) => QUEUE.test(l.text) || IVR.test(l.text) || VOICEMAIL.test(l.text));
  if (recorded && texts.some((x) => QUEUE.test(x))) {
    const wait = /\bestimated (?:wait|hold) time (?:is )?(?:about |approximately )?([\w\s-]{1,25}? minutes?)/i.exec(all)?.[1]?.trim();
    const cb = /\b(?:call ?back|callback)\b/i.test(all);
    const detail = [wait ? `the wait was ${wait}` : '', cb ? 'they offer a callback through their phone menu' : ''].filter(Boolean).join('; ');
    return { kind: 'queue', ...base, ...(detail ? { detail } : {}) };
  }
  if (recorded) return { kind: 'ivr', ...base };
  if (lender.length >= 8) return { kind: 'long', ...base };
  const lastLine = t.at(-1);
  const pacepayClosed = lastLine?.speaker === 'pacepay' && /\b(?:goodbye|bye|thank you for your time|have a (?:good|great|nice) (?:day|one))\b/i.test(lastLine.text);
  const wentQuiet = lastLine?.speaker === 'pacepay' && /\b(?:haven'?t heard (?:anything|back)|went quiet|still there|anyone there|can'?t hear anyone|no one (?:is )?(?:on the line|there)|end the call now)\b/i.test(lastLine.text);
  return { kind: 'hangup', ...base, pacepayClosed, wentQuiet };
}

/** True when the lender said it already made the change (its claim, not a deal PacePay agreed to). */
export function lenderSaidProcessed(transcript: readonly TranscriptLine[] | undefined): boolean {
  return readCallEnd(transcript).kind === 'lender_processed';
}

/**
 * The text after a call that ended without a deal, by how it ended. `terms` is the offer the lender
 * made ("Fri, Nov 13 (no fee)"), if any. Always says nothing changed (or what the lender claims it
 * changed), and carries any reference and the lender's next steps.
 */
export function callEndText(p: { read: CallEndRead; lender: string; itemLabel: string; terms?: string; termsParen?: string; heard?: string }): string {
  const { read, lender, itemLabel } = p;
  const ref = read.reference;
  const again = 'Want me to try again?';
  let body: string;
  let ask = again;
  switch (read.kind) {
    case 'lender_processed':
      body = `${lender} said it already moved your ${itemLabel}${p.termsParen ? ` to ${p.termsParen}` : ''}${ref ? `, ref ${ref}` : ''}, before you approved. I didn't agree to anything.`;
      ask = 'Want me to call back to confirm or undo it?';
      break;
    case 'voicemail':
      body = read.mailboxFull
        ? `I reached ${lender}'s voicemail, but the mailbox was full, so I couldn't leave a message. Nothing changed.`
        : read.leftMessage
          ? `No one answered at ${lender}, so I left a short voicemail. Nothing changed.`
          : `I reached ${lender}'s voicemail and no one answered. Nothing changed.`;
      ask = 'Want me to try again later?';
      break;
    case 'after_hours':
      body = `${lender} is closed right now (I got their after-hours menu), so nothing changed.${read.detail ? ` Their hours: ${read.detail}.` : ''}`;
      ask = 'Want me to try again when they open?';
      break;
    case 'queue':
      body = `I waited in ${lender}'s phone queue but never reached a person${read.detail ? ` (${read.detail})` : ''}, so nothing changed.`;
      ask = 'Want me to try again later?';
      break;
    case 'ivr':
      body = `I couldn't get past ${lender}'s phone menu to a person, so nothing changed.`;
      ask = 'Want me to try again later?';
      break;
    case 'dead_air':
      body = `No one spoke on the line when I called ${lender}, so nothing changed.`;
      break;
    case 'long':
      body = (p.terms || p.heard)
        ? `${lender} offered ${p.terms || p.heard}, but I couldn't get it confirmed clearly before the call ended, so I didn't agree to it. Nothing changed.`
        : `I talked with ${lender} for a while but couldn't get a clear answer on moving your ${itemLabel}, so nothing changed.`;
      break;
    default: {
      const offered = p.terms || p.heard;
      body = read.wentQuiet
        ? offered
          ? `${lender} offered ${offered}, but the line went quiet before it was settled, so I didn't agree to it. Nothing changed.`
          : `The line went quiet before ${lender} confirmed anything, so nothing changed.`
        : read.pacepayClosed
          ? offered
            ? `${lender} offered ${offered}, but it wasn't settled on the call, so I didn't agree to it. Nothing changed.`
            : `${lender} didn't move your ${itemLabel} on this call, so nothing changed.`
          : offered
            ? `${lender} offered ${offered}, but hung up before it was settled, so I didn't agree to it. Nothing changed.`
            : `${lender} hung up before confirming anything, so nothing changed.`;
    }
  }
  // They already said they'll call him back: don't offer to call again as the next step.
  if (ask === again && read.nextSteps.some((x) => x.startsWith('they can call back'))) ask = 'Want me to do anything before then?';
  const refLine = ref && read.kind !== 'lender_processed' ? ` They gave ref ${ref}.` : '';
  const steps = read.nextSteps.length ? ` They said ${read.nextSteps.join(', and ')}.` : '';
  return `${body}${refLine}${steps} ${ask}`.replace(/\s+/g, ' ').trim();
}
