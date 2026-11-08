/**
 * The turn-taking brain of a call, in code (no model decides anything here). Implemented by: voice.
 *
 * The realtime model only listens: it detects the end of each turn and transcribes it, and never
 * answers on its own (create_response is off and it has no tools). For every final turn of the other
 * person, the Conductor calls the server (decide on an outbound call; verify-pin or ask on an inbound
 * one) and speaks the returned `say` verbatim. Also in code:
 *  - fragments: a turn that arrives while the person is already talking again waits for the rest,
 *    and fragments that arrive while a lookup runs are merged into the next lookup;
 *  - fillers: a short "Mm-hm..." when the reply is not playing yet ~1.1 s (inbound 0.6 s) after they
 *    stopped (the lookup OR its audio still coming), then a different one at ~2.5 s (and ~5 s) if still
 *    nothing, so the line never goes quiet for long;
 *  - Yoshua's approval: the hold line at once, then polling with short, never-repeated hold updates,
 *    then the approval line exactly once;
 *  - hanging up: only when the server said next=end_call, after the goodbye has fully played.
 */
import type { DecideResult } from '@pacepay/shared';
import type { VoiceExtras, VoiceServerClient } from './server';

export type LineKind = 'greeting' | 'reply' | 'hold' | 'approval' | 'filler' | 'goodbye' | 'prompt';

/** A line handed to the call: when it has played, whether it was cut off, and how much of it played. */
export interface SpokenLine {
  playout: Promise<void>;
  interrupted(): boolean;
  /** Milliseconds of the line's audio that played (from `fromMs`) before it ended or was cut off. */
  playedMs?(): number;
}

/** What the Conductor needs from the call (agent.ts wires it to LiveKit; tests can fake it). */
export interface CallPort {
  /**
   * Start speaking `text` exactly. Resolves once it is scheduled; `playout` resolves when it has played
   * (or was cut off); `interrupted()` says whether the other person cut it off.
   */
  speak(text: string, kind: LineKind, opts?: { fromMs?: number }): Promise<SpokenLine | undefined>;
  /** True while the other person is talking (their current turn has not ended). */
  userSpeaking(): boolean;
  /** True while PacePay is talking. */
  agentSpeaking(): boolean;
  /** Report the end to the server (once) and hang up. */
  hangUp(reason: string): Promise<void>;
  /** Synthesize lines that may be said soon, so they play at once (optional; failures only cost latency). */
  prepare?(lines: string[]): void;
  /** Start synthesizing a line that WILL be said next (the answer just came back), ahead of queuing it. */
  prime?(text: string): void;
  /**
   * Send keypad tones (an IVR menu). Resolves true once sent, false if this call cannot send them
   * (then the spoken line is said instead). Optional: a port without it always speaks.
   */
  sendDtmf?(digits: string): Promise<boolean>;
  log(...a: unknown[]): void;
}

/** Silence after the other person's turn before a filler plays. */
export const FILLER_AFTER_MS = 1_100;
/** Even when the turn ended long ago, give a just-started lookup this long to answer first. */
export const FILLER_GRACE_MS = 250;
/** A later filler never starts sooner than this after the one before it did. */
export const SECOND_FILLER_GAP_MS = 1_600;
/** Outbound: a second, different filler if the reply still is not playing this long after their turn. */
export const OUTBOUND_SECOND_FILLER_AFTER_MS = 2_500;
/**
 * A slow transcript (noise, load: it came 1.5-2 s after the turn ended in a noisy room) would leave the
 * line quiet before the first filler could even be armed: after a real turn (>= EARLY_FILLER_MIN_SPEECH_MS
 * of speech) with no transcript yet this long after it ended, a filler plays anyway.
 */
export const EARLY_FILLER_AFTER_MS = 1_300;
export const EARLY_FILLER_MIN_SPEECH_MS = 700;
/**
 * The same final transcript again this soon: a duplicate, dropped. Copies were seen up to ~6 s after
 * the first (re-transcribed once our reply started), so a later copy is dropped too, unless our line
 * since then asked them to say it again (a PIN retry, "didn't catch that").
 */
export const DUP_TRANSCRIPT_MS = 8_000;
const ASKS_AGAIN = /\b(?:again|didn'?t catch|say or type|say your|pin)\b/i;
/** When the person's turn ended but no transcript followed (noise), how long to wait before going on. */
const NO_TRANSCRIPT_MS = 2_200; // transcripts came 1.5-1.9 s after a turn under load
/**
 * Words already waiting (their turn came in, then the line picked up a breath or noise): go on after
 * this long without a new transcript instead of NO_TRANSCRIPT_MS. If more words do come, the stale
 * reply is dropped and the whole thing answered again. Measured: "Yeah." then a noise blip waited 2.2 s.
 */
const PENDING_NO_TRANSCRIPT_MS = 1_000;
/** A short answer repeated word for word within this long of the first is a transcription echo. */
const PHANTOM_REPEAT_MS = 2_500;
export const APPROVAL_POLL_MS = 1_000;
/** The server times the approval out at 60 s; this is only a backstop. */
export const APPROVAL_MAX_MS = 75_000;
/**
 * Hold updates while Yoshua decides: each one after this much quiet since PacePay last spoke, so
 * about 12 s, 30 s and 45 s after the hold line when nobody talks, and later if the lender chats.
 */
export const HOLD_UPDATE_GAPS_MS = [12_000, 18_000, 15_000];
export const END_TAIL_MS = 800;
/** A line cut off by noise after this much had played carries on from there (minus a beat), not from the start. */
export const RESUME_MIN_MS = 1_200;
export const RESUME_BACK_MS = 600;
export const END_MAX_MS = 15_000;

/** Short, varied fillers; the "one moment" style is weighted to come up only now and then. */
export const FILLERS: ReadonlyArray<{ text: string; weight: number }> = [
  { text: 'Mm-hm…', weight: 3 },
  { text: 'Okay, let me see…', weight: 3 },
  { text: 'Uh, one sec…', weight: 2 },
  { text: 'Sure, so…', weight: 1 },
  { text: 'Got it, one moment…', weight: 1 },
];

/** Weighted random filler that never repeats the previous pick. */
export function fillerPicker(rand: () => number = Math.random): () => string {
  let last = '';
  return () => {
    const pool = FILLERS.filter((f) => f.text !== last);
    let r = rand() * pool.reduce((n, f) => n + f.weight, 0);
    const pick = pool.find((f) => (r -= f.weight) < 0) ?? pool[pool.length - 1]!;
    last = pick.text;
    return pick.text;
  };
}

/** A picker over a list that never repeats the previous pick. */
export function listPicker(list: readonly string[], rand: () => number = Math.random): () => string {
  let last = '';
  return () => {
    const pool = list.length > 1 ? list.filter((t) => t !== last) : list;
    last = pool[Math.floor(rand() * pool.length)] ?? list[0]!;
    return last;
  };
}

/** Hold updates, each said at most once per call (and worded unlike the server's own hold lines). */
export function holdUpdates(person: string): string[] {
  return [
    `Sorry about the wait. I'm still waiting to hear back from ${person}.`,
    `Still here! ${person} should get back to me any second now.`,
    `Thanks so much for hanging on. Still waiting on ${person}'s answer.`,
  ];
}

export const APPROVAL_FALLBACK_LINE =
  "I haven't heard back yet. Could you hold that offer and give me a reference number? I'll follow up.";
export const LOST_PLACE_LINE = 'Sorry, I lost my place for a moment. Could you say that again?';

/**
 * The negotiator's fixed lines (apps/server/src/agent/negotiator.ts LINES), most likely first: the hold
 * line after "yes" above all, then the asks that follow an offer. Synthesized in the background, a
 * couple at a time, so they start at once; a wording change on the server only costs latency.
 * Lines that depend on the offer (read-backs, counters, the approval line) come from the server's
 * `prepare` lists instead.
 */
export function likelyLines(person: string): string[] {
  const p = person;
  return [
    `Let me confirm that with ${p}.`,
    `Thanks, let me run that by ${p} real quick.`,
    `Okay, I'll check with ${p}. Bear with me.`,
    `Thanks. Let me get ${p}'s okay on that.`,
    'Got it. Is there any way to waive that fee?',
    'I see. Would you be able to waive the fee?',
    'Okay. Could you waive the fee on that one?',
    "Understood. Is there any chance you'd waive the fee?",
    'Is there a day you could move it to?',
    'Okay. Is there another day that would work?',
    'Understood. What day could you move it to?',
    'Take your time.',
    "I'll hold.",
    "Take your time, I'm here.",
    'Okay. How much would the fee be?',
    'Got it. What would the fee be?',
    'Sure. And how much is the fee?',
    'Which exact day would that be?',
    'Sorry, which day exactly?',
    'Is there any way to bring that fee down?',
    'Could you lower the fee at all?',
    'Is there any flexibility on the fee?',
    "I'll wait for the reference number.",
    'And is there a reference number for that?',
    `I'm an AI assistant contacting you on ${p}'s behalf, with ${p}'s permission, and this conversation is transcribed.`,
    `I'm an AI assistant, reaching out with ${p}'s permission, and this conversation is transcribed.`,
    'Sorry, could you say that again?',
    LOST_PLACE_LINE,
  ];
}

/**
 * Lines about the day PacePay asks for (read from the greeting's "...move to Friday, November 13th,
 * with no fee."), worded as the negotiator words them: the read-back when the lender agrees to that
 * day with no fee, the ask again, and the counter back to it. Empty when the greeting has no day.
 */
export function targetDayLines(greeting: string): string[] {
  const m = /move to (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [A-Z][a-z]+ (\d{1,2}(?:st|nd|rd|th))\b/.exec(greeting);
  if (!m) return [];
  const d = `${m[1]} the ${m[2]}`;
  const f = 'with no fee';
  return [
    `Okay, so just to confirm, that's ${d} ${f}?`,
    `Got it. So that's ${d} ${f}, right?`,
    `Just so I have it right, ${d} ${f}?`,
    `Alright, ${d} ${f}. Is that correct?`,
    `Hmm, would ${d} work instead, with no fee?`,
    `Could we do ${d} instead, with no fee?`,
    `What about ${d}, with no fee?`,
    `Is there any chance ${d} would work, with no fee?`,
    `We're hoping to move this month's payment to ${d}, with no fee.`,
    `I'm asking whether this month's payment could move to ${d}, with no fee.`,
  ];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Line noise, "uh", "mm": not worth a turn on its own. */
export function isJunk(text: string): boolean {
  const t = norm(text);
  if (!t) return true;
  // "Uh-huh", "mm-hmm", "mhm": a yes on the phone, never noise.
  if (/^(?:(?:uh huh|uhhuh|mm+ hm+|mhm+|mm+hm+|m hm+) ?)+$/.test(t)) return false;
  return /^(uh+|um+|hmm+|mm+|ah+|oh+|er+|huh)( (uh+|um+|hmm+|mm+|ah+|oh+|er+|huh))*$/.test(t);
}

/**
 * On a speakerphone PacePay's own voice can leak back into the line. A "turn" heard while PacePay was
 * talking whose words are (nearly) all PacePay's own line is that echo, not the other person.
 */
export function isEchoOf(heard: string, line: string): boolean {
  const words = norm(heard).split(' ').filter(Boolean);
  if (words.length < 3 || words.some((w) => /^(yes|yeah|yep|no|nope|not|cant|can|sure|okay|ok)$/.test(w))) return false;
  const mine = new Set(norm(line).split(' '));
  return words.filter((w) => mine.has(w)).length / words.length >= 0.85;
}

/** "Yes", "yeah, that's right", "no": answered fast and never worth a filler. */
export function isShortAnswer(text: string): boolean {
  const t = norm(text).replace(/\b(uh|um|oh|so|well)\b/g, '').trim();
  return t.split(' ').length <= 4 && /^(yes|yeah|yea|yep|yup|ya|sure|correct|right|ok|okay|no|nope|nah|mhm|uh huh|that s right|that s correct|exactly|sounds good|that works)\b/.test(t);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Reply {
  say: string;
  next: 'listen' | 'await_approval' | 'end_call';
  /** Keypad tones to send instead of speaking `say` (an IVR menu); `say` is the fallback. */
  dtmf?: string;
}

/** The shared turn loop. Subclasses answer one (merged) turn in `answer`. */
export abstract class Conductor {
  protected pending: string[] = [];
  protected busy = false;
  protected closing = false;
  /** A reply that came back while the person had started talking again. */
  private held?: Reply;
  /** The words behind the reply in flight (or held), re-sent with whatever they add. */
  private lastUtterance = '';
  private noTranscriptTimer?: NodeJS.Timeout;
  private turnEndedAt = 0;
  /** Turns of theirs that ended, and transcripts that came in: more ended than transcribed means words are still on the way. */
  private turnsEnded = 0;
  private transcriptsIn = 0;
  /** Their last turn with words, and when it ended (to catch a phantom repeat of a short answer). */
  private prevWords = { text: '', endedAt: 0 };
  /** The current turn of theirs began while PacePay was talking. */
  private overlapped = false;
  /** Lender turns answered so far; a line is never spoken twice for the same turn. */
  private turn = 0;
  /** The turn whose reply is not playing yet (its lookup or its audio still coming); 0 when none. */
  private awaiting = 0;
  /** When their current turn began, and when a filler last played before its transcript came in. */
  private speakingSince = 0;
  private earlyFillerAt = 0;
  private earlyFillerTimer?: NodeJS.Timeout;
  private spoken = new Set<string>();
  private lastSpokenAt = 0;
  private lastPlayout: Promise<void> = Promise.resolve();
  /** The last real line, so it can be said again if a noise burst cut it off. */
  private lastLine?: { text: string; kind: LineKind; interrupted(): boolean; playedMs(): number; fromMs: number; resumed: boolean };
  protected nextFiller = fillerPicker();

  constructor(protected port: CallPort) {}

  protected abstract answer(utterance: string): Promise<Reply>;
  /** Whether a filler may play now. */
  protected fillerAllowed(): boolean {
    return true;
  }
  /** Whether a filler may play before their words are transcribed (inbound: only once the PIN is verified). */
  protected earlyFillerAllowed(): boolean {
    return true;
  }
  /** A turn heard over our own line that is only our line coming back. */
  protected isEcho(heard: string, line: string): boolean {
    return isEchoOf(heard, line);
  }
  /** How their words appear in logs (the inbound call hides a spoken PIN). */
  protected shown(utterance: string): string {
    return utterance;
  }
  /** Silence after their turn before the first filler. */
  protected fillerAfterMs(): number {
    return FILLER_AFTER_MS;
  }
  /** Later fillers (each different from the one before), this long after their turn, while the reply is still not playing. */
  protected laterFillersAfterMs(): number[] {
    return [OUTBOUND_SECOND_FILLER_AFTER_MS];
  }
  /** A later filler's words (a different line from the one before). */
  protected secondFiller(): string {
    return this.nextFiller();
  }

  // -- events from the call ------------------------------------------------------------------

  /** The other person started or stopped talking. */
  onUserState(speaking: boolean): void {
    clearTimeout(this.noTranscriptTimer);
    clearTimeout(this.earlyFillerTimer);
    if (speaking) {
      this.overlapped = this.port.agentSpeaking();
      this.speakingSince = Date.now();
      return;
    }
    this.turnEndedAt = Date.now();
    this.turnsEnded += 1;
    // A real turn whose transcript is slow: a filler before the words even arrive (see EARLY_FILLER_AFTER_MS).
    if (this.speakingSince && this.turnEndedAt - this.speakingSince >= EARLY_FILLER_MIN_SPEECH_MS && this.earlyFillerAllowed()) {
      const ended = this.turnsEnded;
      this.earlyFillerTimer = setTimeout(() => {
        if (this.closing || this.busy || this.held || this.awaiting || ended !== this.turnsEnded || this.transcriptsIn >= ended) return;
        if (this.port.agentSpeaking() || this.port.userSpeaking() || !this.fillerAllowed()) return;
        this.earlyFillerAt = Date.now();
        this.port.log('their words are slow to come in: a filler first');
        void this.say(this.nextFiller(), 'filler');
      }, EARLY_FILLER_AFTER_MS);
      this.earlyFillerTimer.unref?.();
    }
    // Noise ends a "turn" with no words: don't wait forever on a transcript that won't come.
    const wait = this.pending.length ? PENDING_NO_TRANSCRIPT_MS : NO_TRANSCRIPT_MS;
    this.noTranscriptTimer = setTimeout(() => {
      this.transcriptsIn = Math.max(this.transcriptsIn, this.turnsEnded); // none is coming
      if (this.port.userSpeaking()) return;
      if (this.held) void this.release();
      else if (this.pending.length) void this.pump();
      else void this.resume();
    }, wait);
  }

  /** A copy of a transcript already handled (dropped by agent.ts): only counted, so no turn waits on it. */
  onDuplicateTranscript(): void {
    this.transcriptsIn += 1;
  }

  /** A final transcript of the other person's turn (may be empty for noise). */
  onTranscript(text: string): void {
    if (this.closing) return;
    clearTimeout(this.noTranscriptTimer);
    this.transcriptsIn += 1;
    const t = text.trim();
    let words = !!t && !isJunk(t);
    if (words && this.overlapped && this.lastLine && this.isEcho(t, this.lastLine.text)) {
      this.port.log(`ignored our own voice coming back: "${this.shown(t)}"`);
      words = false;
    }
    // The same short answer again within a breath ("Yeah." ... "Yeah."): the transcriber hearing the
    // tail of the first one, not a second answer. Never let it count as a second yes.
    if (words && isShortAnswer(t) && norm(t) === norm(this.prevWords.text) && this.turnEndedAt - this.prevWords.endedAt < PHANTOM_REPEAT_MS) {
      this.port.log(`ignored a repeat of their short answer (transcription echo): "${t}"`);
      words = false;
    }
    if (words) this.prevWords = { text: t, endedAt: this.turnEndedAt };
    if (this.held) {
      // They talked while our reply waited. Real words replace it (and are answered together with
      // what came before); noise lets it through.
      if (words) {
        this.port.log(`dropped a stale reply (they kept talking): "${this.held.say}"`);
        this.held = undefined;
        this.pending.unshift(this.lastUtterance);
      } else if (!this.port.userSpeaking()) {
        void this.release();
        return;
      }
    }
    if (words) this.pending.push(t);
    else if (!this.port.userSpeaking() && !this.pending.length) {
      void this.resume();
      return;
    }
    void this.pump();
  }

  // -- the loop ------------------------------------------------------------------------------

  protected async pump(): Promise<void> {
    if (this.busy || this.closing || !this.pending.length) return;
    // They are already talking again: this is the first half of a sentence. Wait for the rest.
    if (this.port.userSpeaking()) return;
    const utterance = this.pending.join(' ');
    this.pending = [];
    this.lastUtterance = utterance;
    this.turn += 1;
    this.busy = true;
    this.awaiting = this.turn;
    let res: Reply;
    // Fillers cover the whole wait for the reply's audio: the lookup AND the synthesis after it.
    const filler = this.armFiller();
    const t0 = Date.now();
    try {
      res = await this.answer(utterance);
    } catch (err) {
      this.port.log('lookup failed:', (err as Error).message);
      res = { say: LOST_PLACE_LINE, next: 'listen' };
    } finally {
      this.busy = false;
    }
    // Synthesis starts now, even if the reply then waits for the rest of what they said.
    if (res.say && !res.dtmf && !this.closing) this.port.prime?.(res.say);
    this.port.log(`t:decided ${Date.now()}`);
    const since = this.turnEndedAt ? Date.now() - this.turnEndedAt : -1;
    this.port.log(`turn ${this.turn}: "${this.shown(utterance)}" -> ${res.next} in ${Date.now() - t0} ms (${since} ms after they stopped)`);
    try {
      await this.deliver(res);
    } finally {
      if (this.awaiting === this.turn) this.awaiting = 0;
      clearInterval(filler);
    }
    void this.pump();
  }

  /** Speak a reply, unless the person has said more since (then that newer turn gets the answer). */
  private async deliver(res: Reply): Promise<void> {
    if (this.closing) return;
    if (res.next === 'end_call') {
      this.awaiting = 0;
      return this.close(res.say, 'the negotiator closed the call');
    }
    if (this.pending.length) {
      // They said more while we were looking it up: answer the whole thing in the next lookup.
      if (res.say) this.port.log(`dropped a stale reply (more was said): "${res.say}"`);
      this.pending.unshift(this.lastUtterance);
      this.afterReply(res, false);
      return;
    }
    // They are talking again, or a later piece of what they said is still being transcribed ("Okay,"
    // ... "your reference number is A 7 7 3 2"): wait for it, so the answer covers all of it.
    if ((this.port.userSpeaking() || this.transcriptOutstanding()) && (res.say || res.dtmf)) {
      if (!this.port.userSpeaking()) this.port.log('waiting for the rest of what they said before answering');
      this.held = res;
      this.afterReply(res, false);
      return;
    }
    if (res.dtmf && (await this.press(res.dtmf))) {
      this.afterReply(res, true);
      return;
    }
    if (res.say) await this.say(res.say, res.next === 'await_approval' ? 'hold' : 'reply');
    this.afterReply(res, true);
  }

  /** Send keypad tones; false (so the spoken fallback is said) when the call cannot send them. */
  protected async press(digits: string): Promise<boolean> {
    if (!this.port.sendDtmf || this.closing) return false;
    try {
      const ok = await this.port.sendDtmf(digits);
      // Never the digits themselves in logs (a PIN may be sent this way).
      this.port.log(ok ? `sent ${digits.replace(/[^0-9*#]/g, '').length} keypad tone(s) instead of speaking` : 'keypad tones not available; speaking instead');
      return ok;
    } catch (err) {
      this.port.log('keypad tones failed, speaking instead:', (err as Error).message);
      return false;
    }
  }

  /** A turn of theirs ended recently and its transcript has not come in yet. */
  private transcriptOutstanding(): boolean {
    return this.turnsEnded > this.transcriptsIn && Date.now() - this.turnEndedAt < NO_TRANSCRIPT_MS;
  }

  private async release(): Promise<void> {
    const r = this.held;
    this.held = undefined;
    if (r && !this.closing && !this.busy) {
      if (r.dtmf && (await this.press(r.dtmf))) return void this.pump();
      await this.say(r.say, r.next === 'await_approval' ? 'hold' : 'reply');
    }
    void this.pump();
  }

  /** Their "turn" was only noise. If it cut our last line off, say that line again (once). */
  private async resume(): Promise<void> {
    const l = this.lastLine;
    if (!l || l.resumed || this.busy || this.closing || this.held || this.pending.length) return;
    if (!l.interrupted() || this.port.agentSpeaking() || this.port.userSpeaking()) return;
    l.resumed = true;
    // Carry on from just before where it was cut (never restart a line that was mostly said).
    const at = l.fromMs + l.playedMs();
    const from = at >= RESUME_MIN_MS ? Math.max(0, at - RESUME_BACK_MS) : 0;
    this.port.log(`resuming a line cut off by noise${from ? ` from ${(from / 1000).toFixed(1)} s` : ''}: "${l.text}"`);
    await this.say(l.text, l.kind, true, from);
  }

  /** Hook after a reply (spoken or not): the outbound call starts the approval wait here. */
  protected afterReply(_res: Reply, _spoken: boolean): void {}

  /**
   * Fillers while their reply is not playing yet: the first FILLER_AFTER_MS (inbound 600 ms) after
   * their turn ended, then each later one (laterFillersAfterMs) if the reply still is not playing, never
   * over a line already playing or over them, and never within SECOND_FILLER_GAP_MS of the one before.
   * Stops the moment the reply is queued (its audio is ready), the call closes, or another turn starts.
   */
  private armFiller(): NodeJS.Timeout {
    const started = Date.now();
    const anchor = this.turnEndedAt && started - this.turnEndedAt < 5_000 ? this.turnEndedAt : started;
    const times = [this.fillerAfterMs(), ...this.laterFillersAfterMs()];
    const turn = this.turn;
    // A filler already played for this turn before its words came in: the next one is a later one.
    const early = this.earlyFillerAt >= anchor;
    let k = early ? 1 : 0;
    let lastAt = early ? this.earlyFillerAt : 0;
    const timer = setInterval(() => {
      if (this.awaiting !== turn || this.closing || k >= times.length) return clearInterval(timer);
      const now = Date.now();
      if (now < Math.max(anchor + times[k]!, started + FILLER_GRACE_MS) || (lastAt && now - lastAt < SECOND_FILLER_GAP_MS)) return;
      if (!this.fillerAllowed() || this.port.agentSpeaking() || this.port.userSpeaking()) return;
      lastAt = now;
      void this.say(k === 0 ? this.nextFiller() : this.secondFiller(), 'filler');
      k++;
    }, 50);
    timer.unref?.();
    return timer;
  }

  /**
   * The only way a line is spoken. A line is never spoken twice for the same lender turn, whoever
   * asked for it (decide, the approval poll, a hold update); `again` is only for a line cut off by noise.
   */
  protected async say(text: string, kind: LineKind, again = false, fromMs = 0): Promise<boolean> {
    const t = text.trim();
    if (!t || (this.closing && kind !== 'goodbye')) return false;
    const key = `${this.turn}|${norm(t)}`;
    if (kind !== 'filler' && !again && this.spoken.has(key)) {
      this.port.log(`skipped a repeat (${kind}): "${t}"`);
      return false;
    }
    this.spoken.add(key);
    this.lastSpokenAt = Date.now();
    this.port.log(`say (${kind}): "${t}"`);
    const h = await this.port.speak(t, kind, fromMs ? { fromMs } : undefined);
    if (h) {
      this.lastPlayout = h.playout;
      void h.playout.then(() => (this.lastSpokenAt = Math.max(this.lastSpokenAt, Date.now())));
      if (kind !== 'filler') this.lastLine = { text: t, kind, interrupted: h.interrupted, playedMs: () => h.playedMs?.() ?? 0, fromMs, resumed: again };
    }
    return !!h;
  }

  /** Time since PacePay last spoke (since that line finished playing, once it has). */
  protected msSinceSpoke(): number {
    return Date.now() - this.lastSpokenAt;
  }

  /** Say the last line, let it play out fully, a short tail, then report and hang up. */
  protected async close(say: string, reason: string): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    // Let them finish their sentence before the goodbye (capped).
    for (let i = 0; i < 40 && this.port.userSpeaking(); i++) await sleep(100);
    if (say) await this.say(say, 'goodbye');
    await Promise.race([this.lastPlayout.catch(() => undefined), sleep(END_MAX_MS)]);
    await sleep(END_TAIL_MS);
    await this.port.hangUp(reason);
  }

  /** The call ended from the other side. */
  stop(): void {
    this.closing = true;
    clearTimeout(this.noTranscriptTimer);
    clearTimeout(this.earlyFillerTimer);
  }
}

/**
 * Dead air on an outbound call (nobody talking, nothing in flight, not holding for Yoshua): a short,
 * varied check-in after DEAD_AIR_CHECK_MS of quiet, again after each further DEAD_AIR_CHECK_MS; after
 * DEAD_AIR_MAX_CHECKS unanswered check-ins (NO_ANSWER_MAX_CHECKS when nobody ever spoke, HOLD_MAX_CHECKS on
 * a lender hold), or DEAD_AIR_GIVE_UP_MS of
 * quiet in all, a neutral goodbye
 * that says what was or wasn't agreed, then hang up. When the lender put PacePay on hold ("one moment",
 * "let me transfer you"), the same with the longer HOLD_* times.
 */
export const DEAD_AIR_CHECK_MS = Number(process.env.PACEPAY_DEAD_AIR_MS) || 20_000;
export const DEAD_AIR_GIVE_UP_MS = Number(process.env.PACEPAY_DEAD_AIR_GIVE_UP_MS) || 90_000;
export const HOLD_CHECK_MS = Number(process.env.PACEPAY_HOLD_CHECK_MS) || 40_000;
export const HOLD_GIVE_UP_MS = Number(process.env.PACEPAY_HOLD_GIVE_UP_MS) || 160_000;
/** Nobody has said a word since the greeting: two check-ins, then goodbye. */
export const NO_ANSWER_MAX_CHECKS = 2;
export const DEAD_AIR_MAX_CHECKS = 3;
export const HOLD_MAX_CHECKS = 3;
/** The lender asked PacePay to wait: a hold or a transfer, not dead air. */
const LENDER_HOLD =
  /\b(one|a|just a) (moment|sec|second|minute|min)\b|\b(hold on|hang on|please hold|hold please|hold for|bear with me|stay on the line|hold the line|give me (a|one) (sec|second|minute|moment)|let me (check|look|pull|see|get|find|grab|transfer|connect|put you)|i ?ll (check|look|transfer|connect|get)|transfer(ring)? you|put you (on hold|through)|while i)\b/i;
/** A hold recording or announcement: still on hold, not a person back on the line. */
const HOLD_RECORDING =
  /\b(your call is (very )?important|please (continue to )?hold|(remain|stay) on hold|remain on the line|next available|in the order (it was|they were) received|estimated (wait|hold)|did you know|on our (app|website)|visit (us|our)|calls? (may be|is being) (monitored|recorded)|all (of )?our (agents|representatives))\b/i;
/** A new person picking up after a hold or transfer ("Thanks for waiting, how can I help?", "Collections, this is Marcus"). */
const NEW_PERSON =
  /\b(this is|my name is|you'?ve reached|you are speaking (with|to)|you'?re speaking (with|to)|speaking with) [a-z]+|\bhow (can|may|could) i (help|assist)\b|\bwho (am i|is this) (speaking|talking) (with|to)\b|\bwho is (this|calling)\b|\bwhat can i (do|help)\b/i;
/** The disclosure for a new person, from the greeting ("...about the auto loan ending 4417. This call is transcribed."). */
export function reintroLine(greeting: string, person: string): string {
  const about = /\babout (?:the |your )?([a-z ]{2,30}?) ending (\d{4})\b/i.exec(greeting);
  const what = about ? `, about the ${about[1]!.trim()} ending ${about[2]}` : '';
  return `Hi, I'm PacePay, an AI assistant calling on ${person}'s behalf, with ${person}'s permission${what}. This call is transcribed.`;
}

export const DEAD_AIR_CHECKS = {
  /** Nobody has said a word since the greeting. */
  unanswered: ['Hello? Can you hear me?', 'Hello? Is anyone there?', "Hi, I'm still on the line. Can you hear me?"],
  talking: ['Hello? Are you still there?', 'Sorry, are you still on the line?', 'Hi, just checking. Are you still there?', 'Hello? Did I lose you?', "Sorry, I think the line went quiet. Are you there?"],
  hold: ["Hi, I'm still on the line whenever you're ready.", 'Just checking in. I am still holding.', "Hello? I'm still here.", "Still holding on my end, no rush."],
};
export const DEAD_AIR_GOODBYE = {
  /** Nobody ever answered after the greeting. */
  noAnswer: "I can't hear anyone on the line, so I'll end the call now. Nothing has been changed. Goodbye.",
  /** PacePay never agrees to anything Yoshua hasn't approved, so this is always true (whatever the lender said). */
  nothing: "I haven't heard anything for a while, so I'll end the call now. I haven't agreed to any change on this call. Goodbye.",
  /** Terms went to Yoshua: the server decides what stands; never claim a deal or deny one here. */
  approved: "I haven't heard back for a while, so I'll end the call here. Thanks, goodbye.",
};

/** Outbound: PacePay calling the lender. Every lender turn goes to decide. */
export class OutboundConductor extends Conductor {
  private approvalActive = false;
  /** Dead air: when the line went quiet, check-ins said since the lender last spoke, and the watch timer. */
  private lenderAt = 0;
  private lenderSpoke = false;
  private lenderHold = false;
  private checks = 0;
  /** Check-in lines already said this call (none is ever said twice). */
  private checksSaid = new Set<string>();
  /** Terms went to Yoshua at some point: a quiet-line goodbye then never says "nothing was agreed". */
  private askedYoshua = false;
  /** The lender put PacePay on hold or transferred it since it last said it is an AI: a new voice gets the disclosure again. */
  private heldSinceIntro = false;
  private greeting = '';
  /** Hold recordings heard while on hold: never sent to decide (PacePay stays quiet through the music). */
  private recordings = new Set<string>();
  /** The words that put PacePay on hold (the same turn never counts as the new person). */
  private holdTurn = '';
  private deadAirTimer?: NodeJS.Timeout;
  /** Approval-outcome lines already spoken, whoever (poll or decide) brought them. */
  private approvalSaid = new Set<string>();
  private holds: string[];
  /** Lines the server said may come next, already handed to prepare(). */
  private prepared = new Set<string>();

  constructor(
    port: CallPort,
    private server: VoiceServerClient,
    private callId: string,
    private person: string,
  ) {
    super(port);
    this.holds = holdUpdates(person);
    // The greeting is spoken by the caller of this class straight through the port (agent.ts, the stress
    // harness): the dead-air watch starts once it has played.
    const speak = port.speak.bind(port);
    port.speak = async (text, kind, opts) => {
      const h = await speak(text, kind, opts);
      if (kind === 'greeting') {
        this.greeting = text;
        this.watchDeadAir();
        void h?.playout.then(() => (this.lenderAt = Math.max(this.lenderAt, Date.now())));
      }
      return h;
    };
  }

  override onUserState(speaking: boolean): void {
    this.lenderAt = Date.now();
    this.watchDeadAir();
    super.onUserState(speaking);
  }

  override onTranscript(text: string): void {
    this.lenderAt = Date.now();
    if (text.trim() && !isJunk(text)) {
      this.lenderSpoke = true;
      this.checks = 0;
      // A hold stays a hold through its recordings ("Your call is important to us..."), which get no answer.
      if (this.lenderHold && HOLD_RECORDING.test(text) && !NEW_PERSON.test(text)) this.recordings.add(text.trim());
      this.lenderHold = LENDER_HOLD.test(text) || (this.lenderHold && HOLD_RECORDING.test(text) && !NEW_PERSON.test(text));
      if (this.lenderHold && !this.heldSinceIntro) {
        this.heldSinceIntro = true;
        this.holdTurn = text.trim();
      }
    }
    this.watchDeadAir();
    super.onTranscript(text);
  }

  override stop(): void {
    clearInterval(this.deadAirTimer);
    super.stop();
  }

  private watchDeadAir(): void {
    if (this.deadAirTimer || this.closing) return;
    this.lenderAt = Math.max(this.lenderAt, Date.now());
    this.deadAirTimer = setInterval(() => void this.checkDeadAir(), 500);
    this.deadAirTimer.unref?.();
  }

  /** Quiet on the line: check in now and then, and give up politely after a while. */
  private async checkDeadAir(): Promise<void> {
    if (this.closing) return clearInterval(this.deadAirTimer);
    const now = Date.now();
    if (this.busy || this.pending.length || this.approvalActive || this.port.userSpeaking() || this.port.agentSpeaking()) {
      // Something is going on (or we hold for Yoshua, which has its own updates and backstop).
      if (this.port.userSpeaking() || this.busy) this.lenderAt = now;
      return;
    }
    const quietSinceLender = now - this.lenderAt;
    const quiet = Math.min(quietSinceLender, this.msSinceSpoke());
    const check = this.lenderHold ? HOLD_CHECK_MS : DEAD_AIR_CHECK_MS;
    const giveUp = this.lenderHold ? HOLD_GIVE_UP_MS : DEAD_AIR_GIVE_UP_MS;
    if (quiet < check && quietSinceLender < giveUp) return;
    const maxChecks = !this.lenderSpoke ? NO_ANSWER_MAX_CHECKS : this.lenderHold ? HOLD_MAX_CHECKS : DEAD_AIR_MAX_CHECKS;
    if (this.checks >= maxChecks || quietSinceLender >= giveUp) {
      clearInterval(this.deadAirTimer);
      this.port.log(`dead air: ${Math.round(quietSinceLender / 1000)} s since the lender last spoke, ${this.checks} check-in(s) unanswered; ending the call`);
      const bye = this.askedYoshua ? DEAD_AIR_GOODBYE.approved : this.lenderSpoke ? DEAD_AIR_GOODBYE.nothing : DEAD_AIR_GOODBYE.noAnswer;
      return this.close(bye, 'the line went quiet');
    }
    const pool = !this.lenderSpoke ? DEAD_AIR_CHECKS.unanswered : this.lenderHold ? DEAD_AIR_CHECKS.hold : DEAD_AIR_CHECKS.talking;
    const all = [...pool, ...DEAD_AIR_CHECKS.talking, ...DEAD_AIR_CHECKS.hold];
    const line = all.find((l) => !this.checksSaid.has(l)) ?? pool[this.checks % pool.length]!;
    this.checksSaid.add(line);
    this.checks += 1;
    this.port.log(`dead air: ${Math.round(quiet / 1000)} s of quiet, check-in ${this.checks}`);
    await this.say(line, 'prompt');
  }

  protected override async answer(utterance: string): Promise<Reply> {
    if (this.recordings.has(utterance.trim())) {
      this.port.log(`on hold: a recording, no answer: "${utterance}"`);
      return { say: '', next: 'listen' };
    }
    const newPerson = this.heldSinceIntro && !utterance.includes(this.holdTurn) && NEW_PERSON.test(utterance);
    const res: DecideResult & VoiceExtras = await this.server.decide(this.callId, utterance);
    this.prefetch(res.prepare);
    let say = res.say?.trim() ?? '';
    if (newPerson && say && !res.dtmf && res.next === 'listen' && !/\bending \d{4}\b/.test(say)) {
      // Someone new after a hold or transfer: they hear who is calling, for whom, about which loan, and
      // that it is transcribed (the server's own disclosure sentences give way to the full one).
      this.port.log('new person after a hold/transfer: full disclosure again');
      const rest = say.split(/(?<=[.?!])\s+/).filter((x) => !/\b(AI|transcribed|PacePay)\b/.test(x)).join(' ');
      say = `${reintroLine(this.greeting, this.person)}${rest ? ` ${rest}` : ''}`;
    }
    if (/\bAI\b/.test(say)) this.heldSinceIntro = false;
    // PacePay itself said it will wait ("Take your time", "I'll hold"): quiet that follows is a hold, not dead air.
    if (/\b(take your time|i'?ll hold|i'?ll wait|no rush|bear with me)\b/i.test(say)) this.lenderHold = true;
    // decide repeats the approval outcome if the lender speaks after it: never say it twice.
    if (say && this.approvalSaid.has(norm(say))) {
      this.port.log(`skipped the approval line again: "${say}"`);
      say = '';
    }
    if (this.approvalActive && res.next !== 'await_approval') {
      // decide brought Yoshua's answer itself (the lender spoke as it came in): the poll stands down.
      this.approvalActive = false;
      if (say) this.approvalSaid.add(norm(say));
    }
    return { say, next: res.next, ...(res.dtmf ? { dtmf: res.dtmf } : {}) };
  }

  /** Hand lines the server says may come next to prepare(), each once per call. */
  private prefetch(lines: string[] | undefined): void {
    const fresh = (lines ?? []).filter((l) => !this.prepared.has(l));
    fresh.forEach((l) => this.prepared.add(l));
    if (fresh.length) this.port.prepare?.(fresh);
  }

  protected override afterReply(res: Reply, _spoken: boolean): void {
    if (res.next === 'await_approval') {
      this.askedYoshua = true;
      void this.awaitApproval();
    } else if (this.approvalActive) {
      // decide already brought the outcome (the lender spoke as Yoshua answered).
      this.approvalActive = false;
      if (res.say) this.approvalSaid.add(norm(res.say));
    }
  }

  private async awaitApproval(): Promise<void> {
    if (this.approvalActive) return;
    this.approvalActive = true;
    const started = Date.now();
    let slot = 0;
    while (this.approvalActive && !this.closing) {
      await sleep(APPROVAL_POLL_MS);
      if (!this.approvalActive || this.closing) return;
      let out: Awaited<ReturnType<VoiceServerClient['approval']>> | undefined;
      try {
        out = await this.server.approval(this.callId);
      } catch (err) {
        this.port.log('approval poll failed:', (err as Error).message);
      }
      if (!this.approvalActive || this.closing) return;
      if (out?.status === 'pending') this.prefetch(out.prepare);
      if (out && out.status !== 'pending') {
        this.approvalActive = false;
        const say = out.say?.trim() ?? '';
        const fresh = !!say && !this.approvalSaid.has(norm(say));
        if (say) this.approvalSaid.add(norm(say));
        if (out.next === 'end_call') return this.close(fresh ? say : '', `approval ${out.status}`);
        // Wait for the lender to finish a sentence and for any lookup in flight.
        for (let i = 0; i < 50 && (this.port.userSpeaking() || this.busy); i++) await sleep(100);
        if (out.dtmf && (await this.press(out.dtmf))) return;
        if (fresh) await this.say(say, 'approval');
        return;
      }
      const elapsed = Date.now() - started;
      if (elapsed >= APPROVAL_MAX_MS) {
        this.approvalActive = false;
        return this.close(APPROVAL_FALLBACK_LINE, 'approval never resolved');
      }
      // Hold updates: each worded differently, each said once, only into a quiet line.
      if (slot < HOLD_UPDATE_GAPS_MS.length && this.msSinceSpoke() >= HOLD_UPDATE_GAPS_MS[slot]!) {
        if (!this.busy && !this.port.userSpeaking() && !this.port.agentSpeaking()) {
          await this.say(this.holds[slot]!, 'hold');
          slot++;
        }
      }
    }
  }
}

/**
 * Spoken PIN digits: "one two three four", "1 2 3 4", and pairs said as numbers: "twelve thirty-four"
 * -> 1234 ("thirteen thirty-four" -> 1334, a wrong try, not a re-prompt).
 */
export function spokenDigits(text: string): string {
  const all = digitsIn(text);
  // Too many digits because the transcriber added a sentence ("1, 2, 3, 4. Four."): a sentence that
  // holds exactly four is the PIN said.
  if (all.length > KEYPAD_PIN_LENGTH) {
    for (const s of text.split(/[.!?]+(?:\s+|$)/)) {
      const d = digitsIn(s);
      if (d.length === KEYPAD_PIN_LENGTH) return d;
    }
  }
  return all;
}

function digitsIn(text: string): string {
  const words: Record<string, string> = {
    zero: '0', oh: '0', o: '0', one: '1', won: '1', two: '2', to: '2', too: '2', three: '3', four: '4', for: '4',
    five: '5', six: '6', seven: '7', eight: '8', ate: '8', nine: '9',
  };
  const teens: Record<string, string> = {
    ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19',
  };
  const tens: Record<string, string> = { twenty: '2', thirty: '3', forty: '4', fourty: '4', fifty: '5', sixty: '6', seventy: '7', eighty: '8', ninety: '9' };
  const toks = text.toLowerCase().replace(/(\d)/g, ' $1 ').split(/[^a-z0-9]+/).filter(Boolean);
  const unit = (w: string | undefined) => (w === undefined ? null : /^[1-9]$/.test(w) ? w : words[w] && words[w] !== '0' ? words[w]! : null);
  const out: (string | null)[] = [];
  /** Per entry of `out`: it came from a sound-alike word ("to", "for", "oh"). */
  const loose: boolean[] = [];
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i]!;
    loose[out.length] = LOOSE_DIGIT.has(w);
    if (/^\d$/.test(w)) out.push(w);
    else if (teens[w]) out.push(teens[w]!);
    else if (tens[w]) {
      // "thirty-four" -> 34, a lone "thirty" -> 30.
      const u = unit(toks[i + 1]);
      out.push(tens[w]! + (u ?? '0'));
      if (u) i++;
    } else out.push(words[w] ?? null);
  }
  // "One thousand two hundred thirty-four" / "twelve hundred thirty four": a number said whole.
  const whole = cardinal(toks);
  if (whole) return whole;
  // Only count number words that sit next to other digits ("to", "for" and "oh" are ordinary words too).
  const longest = (ds: (string | null)[]) => {
    let best = '';
    let run = '';
    for (const d of ds) {
      if (d === null) {
        if (run.length > best.length) best = run;
        run = '';
      } else run += d;
    }
    return run.length > best.length ? run : best;
  };
  const best = longest(out);
  // Too many digits because a sound-alike joined in ("one two three four for" in a noisy room): the
  // four clear digits, if that is what is left without the sound-alikes.
  if (best.length > KEYPAD_PIN_LENGTH) {
    const strict = longest(out.map((d, i) => (loose[i] ? null : d)));
    if (strict.length === KEYPAD_PIN_LENGTH) return strict;
  }
  return best.length >= 3 ? best : '';
}
/** Ordinary words that sound like digits ("to", "for", "oh"). */
const LOOSE_DIGIT = new Set(['oh', 'o', 'won', 'to', 'too', 'for', 'ate']);

/** A 4-digit number said as a number ("one thousand two hundred thirty-four", "twelve hundred thirty four"), else ''. */
function cardinal(toks: string[]): string {
  if (!toks.some((t) => t === 'thousand' || t === 'hundred')) return '';
  const small: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
    seventy: 70, eighty: 80, ninety: 90,
  };
  let total = 0;
  let cur = 0;
  let any = false;
  for (const t of toks) {
    if (t in small) {
      cur += small[t]!;
      any = true;
    } else if (/^\d+$/.test(t) && t.length <= 2) {
      cur += Number(t);
      any = true;
    } else if (t === 'hundred') cur = (cur || 1) * 100;
    else if (t === 'thousand') {
      total += (cur || 1) * 1000;
      cur = 0;
    } else if (t !== 'and' && any) break;
  }
  const n = total + cur;
  return any && n >= 1000 && n <= 9999 ? String(n) : '';
}

/** A digit-free outline of a PIN try for logs ("# # # #", "N N", "N thousand N hundred N"): never the digits. */
export function pinShape(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d/g, '#')
    .replace(/\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/g, 'N')
    .slice(0, 80);
}

const GOODBYE =
  /\b(bye|goodbye|bye bye|that'?s all|that is all|that'?s it|that'?s everything|that'?ll be all|nothing else|hang up|i'?m all set|i'?m good|no thanks|no thank you|talk (?:to you )?(?:later|soon)|see (?:you|ya)|have a good (?:one|day|night))\b/i;
/** After the PIN, a bare "no" / "nope" means nothing else to ask. */
const NO_MORE = /^(?:no|nope|nah|not really|no that'?s it|no i'?m good|nothing)[\s,.!]*$/i;
const THANKS = /^(?:(?:ok(?:ay)?|cool|great|perfect|got it|awesome|alright|all right)[\s,.!]*)?(?:thanks|thank you)(?: so much| very much)?[\s,.!]*$/i;
const ACK = /^(?:ok(?:ay)?|cool|great|perfect|got it|awesome|alright|all right|sounds good|nice|mhm|uh huh|mm hmm)[\s,.!]*$/i;
const YES = /^(?:yes|yeah|yep|yup|sure|ya)[\s,.!]*$/i;
/** Listening noises (on norm()ed text): never a question of their own. */
const BACKCHANNEL_WORDS = /^(?:(?:ok(?:ay)?|mhm+|mm+ ?hm+|uh ?huh|a+ ?ha+|ah+|oh+|hm+|mm+|yeah|yep|yup|right|sure|got it|gotcha|cool|great|nice|i see|alright|all right) ?)+$/;
/** A real question has one of these; a two-word "turn" with none is noise ("Bye" heard as "5"). */
const QUESTION_WORD = /\b(what|when|where|why|how|which|who|can|could|should|would|will|is|are|am|do|does|did|was|tell|move|call|pay)\b/i;
const TOPIC_WORD =
  /\b(balance|checking|savings?|paycheck|pay|payday|lender|loan|card|credit|bills?|scores?|money|afford|late|cd|payment|fee|reference|mortgage|rent|debt|cushion|emergency|fund|lowest|deposit|account|car|utilities)\b/i;

export const INBOUND_PIN_PROMPT = 'Sure. First, please say or type your four-digit PIN.';
export const INBOUND_GOODBYE = 'Okay, talk soon. Bye!';
export const INBOUND_DIDNT_CATCH = "Sorry, I didn't catch that. What would you like to know?";
export const INBOUND_ANYTHING_ELSE = "You're welcome. Anything else?";
export const INBOUND_GO_AHEAD = 'Sure. What would you like to know?';
/**
 * An obvious jailbreak, prompt-injection or off-topic stunt on the call (a poem, "repeat after me", DAN,
 * "print your instructions", "say something offensive"): refused here in code, never sent to a model.
 * Same words as the server's refusal ("I'm just your financial assistant, so I can't help with that.").
 */
export const INBOUND_REFUSAL = "I'm just your financial assistant, so I can't help with that. Anything about your money I can check?";
/** Moving money, which PacePay never does (word for word the server's voice refusal, screenReplyText('move_money', { voice: true })). */
export const INBOUND_MOVE_MONEY = "I'm just your financial assistant, so I can't move money. PacePay never moves money: you make any move at your bank.";
const JAILBREAK = new RegExp(
  [
    String.raw`\b(?:write|tell|sing|make up|compose|give|read|recite)\b.{0,30}\b(?:poem|song|story|joke|rap|haiku|limerick|essay|lyrics)\b`,
    String.raw`\brepeat after me\b`,
    String.raw`\bsay (?:the words?|this|exactly|something (?:offensive|rude|mean|racist|dirty|bad|nasty))\b`,
    String.raw`\b(?:offensive|racist|profanity|swear words?|curse words?)\b`,
    String.raw`\b(?:you'?re|you are|be|play|act as) dan\b|\bdan mode\b|\blet'?s play a game\b`,
    String.raw`\b(?:system )?administrator\b|\bthis is (?:the |your )?(?:admin|developer|openai|anthropic|creator|programmer|engineer)s?\b`,
    String.raw`\b(?:turn off|disable|skip|remove|bypass|switch off)\b.{0,25}\b(?:pin|security|verification|safety|filters?)\b`,
    String.raw`\bfacts? block\b|\b(?:what|which)\b.{0,20}\binstructions\b|\binstructions (?:were you|did you|you were|have you)\b`,
    String.raw`\b(?:print|show|read|repeat|recite|tell me|give me|dump|output)\b.{0,25}\b(?:system prompt|your prompt|your instructions|your rules|your programming|your configuration|hidden)\b`,
    String.raw`\b(?:ignore|disregard|forget|override|bypass|drop)\b.{0,40}\b(?:instructions?|rules|prompts?|guidelines|programming|guardrails|restrictions|system)\b`,
    String.raw`\bsystem (?:prompt|message|instructions?)\b`,
    String.raw`\b(?:developer|dev|god|admin|debug) mode\b`,
    String.raw`\bjail ?break`,
    String.raw`\bdo anything now\b`,
    String.raw`\b(?:pretend|imagine) (?:that )?(?:you(?: a|')re|you are|to be)\b`,
    String.raw`\b(?:you are|you're) now\b`,
    String.raw`\bfrom now on,? you\b`,
    String.raw`\b(?:repeat|reveal|print|recite|read(?: me)?|show(?: me)?|tell me) (?:back )?(?:your|the) (?:hidden |secret |original )?(?:instructions|prompt|rules|guidelines)\b`,
  ].join('|'),
  'i',
);
export const isJailbreak = (text: string): boolean => JAILBREAK.test(text);
/**
 * "Transfer five hundred dollars to checking", "pay my mortgage", "can you move money for me": a request
 * to move money (never a question about it: "can I afford...", "when do I pay..." are not this).
 */
const MOVE_MONEY = new RegExp(
  [
    String.raw`^(?:(?:okay|ok|so|um|uh|hey|and|then)[\s,]+)*(?:(?:can|could|would|will) you (?:please )?|please |i (?:want|need) you to |go ahead and )?(?:transfer|wire|withdraw|deposit|zelle|venmo)\b`,
    String.raw`^(?:(?:okay|ok|so|um|uh|hey|and|then)[\s,]+)*(?:(?:can|could|would|will) you (?:please )?|please |i (?:want|need) you to |go ahead and )?(?:move|send|put)\b.{0,30}(?:\b(?:money|dollars|bucks|funds|cash|savings|checking)\b|\$\d)`,
    String.raw`^(?:(?:okay|ok|so|um|uh|hey|and|then)[\s,]+)*(?:(?:can|could|would|will) you (?:please )?|please |i (?:want|need) you to |go ahead and )?pay (?:off )?(?:my|the|it|that|this|them|all)\b`,
    String.raw`\b(?:can|could|will|would) you (?:move|transfer|send) (?:some |the )?(?:money|funds|cash)\b`,
  ].join('|'),
  'i',
);
export const isMoveMoney = (text: string): boolean => MOVE_MONEY.test(text.trim());
/** Said before hanging up on a caller who has gone quiet. */
export const INBOUND_IDLE_GOODBYE = "I haven't heard anything for a bit, so I'll let you go. Call or text me anytime. Bye!";
/** Hang up after this long with nobody talking (the caller put the phone down). */
export const INBOUND_IDLE_MS = Number(process.env.PACEPAY_VOICE_IDLE_MS) || 20_000;
/** Keypad PIN: four digits, or fewer ended with #; * starts over; a pause this long sends what was typed. */
export const KEYPAD_PIN_LENGTH = 4;
export const KEYPAD_IDLE_MS = 5_000;
/** Marks a typed PIN inside the turn loop (never a character a transcript contains). */
const KEYPAD = '\u0001';
/** The server's fixed inbound lines (apps/server/src/api/voice.ts), synthesized before the call so they play at once. */
export const INBOUND_GREETING = "Hi, this is PacePay, Yoshua's money assistant. For your security, please say your four-digit PIN.";
export const INBOUND_SERVER_LINES = [
  'Thanks, you are verified. What would you like to know?',
  'That PIN did not match. Please say it again.',
  'I could not verify the PIN, so I have to end the call. Goodbye.',
  'I can only discuss account details with the account holder.',
  "Text me and I'll set it up.",
  "Sorry, that's taking longer than it should. Ask me again in a moment.",
];
/**
 * The wording suggested for the server once typed PINs work (api/voice.ts owns it): synthesized too,
 * so whichever the server sends plays from memory.
 */
export const INBOUND_GREETING_TYPED = "Hi, this is PacePay, Yoshua's money assistant. For your security, please say or type your four-digit PIN.";
export const INBOUND_PIN_RETRY_TYPED = 'That PIN did not match. Please say or type it again.';
/** Every fixed line of an inbound call, most needed first. */
export const INBOUND_FIXED_LINES = [INBOUND_GREETING, INBOUND_GREETING_TYPED, ...INBOUND_SERVER_LINES.slice(0, 2), INBOUND_PIN_PROMPT, INBOUND_GOODBYE, INBOUND_DIDNT_CATCH, ...INBOUND_SERVER_LINES.slice(2), INBOUND_ANYTHING_ELSE, INBOUND_GO_AHEAD, INBOUND_REFUSAL, INBOUND_PIN_RETRY_TYPED, INBOUND_MOVE_MONEY];
/**
 * Inbound fillers: the first comes fast (~0.6 s after his turn ended), a second, different one only if
 * the answer is still not playing (~2.5 s), a third (the other second-filler line) at ~5 s.
 */
export const INBOUND_FILLER_AFTER_MS = 600;
export const INBOUND_SECOND_FILLER_AFTER_MS = 2_500;
export const INBOUND_THIRD_FILLER_AFTER_MS = 5_000;
export const INBOUND_SECOND_FILLERS = ['Still checking, one sec…', 'Almost there…'];
/** Inbound first fillers: short (~0.3-0.6 s), so a reply that is ready a moment later never waits behind a long one. */
export const INBOUND_FIRST_FILLERS = ['Mm-hm…', 'Okay…', 'Hmm…'];
/** "All right. Five." = "Alright, bye." misheard: an acknowledgement then a bye sound-alike, as a goodbye. */
const ACK_BYE = /^(?:(?:ok(?:ay)?|alright|all right|right|thanks|thank you|cool|great|perfect) )+(?:bye|by|buy|five|5)$/;
/** A PIN said in pieces ("one two" ... "three four"): the first piece waits this long for the rest. */
export const PIN_FRAGMENT_MS = 3_500;
/** Once a PIN piece is waiting, a lone "To." or "For." is the next digit ("1." "To." "3." "4." was one PIN). */
const SOUND_ALIKE: Record<string, string> = { to: '2', too: '2', for: '4', oh: '0', won: '1', ate: '8' };
const STRICT_DIGIT: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
/**
 * A piece of a PIN: 1-3 digits ("1 2", "one two") in a turn that is mostly digits. Only clear digit
 * words count ("to", "for" are ordinary words). '' when it is not a PIN piece.
 */
export function pinFragment(text: string, soundAlikes = false): string {
  const toks = text.toLowerCase().replace(/(\d)/g, ' $1 ').split(/[^a-z0-9]+/).filter(Boolean).filter((w) => !/^(?:uh+|um+|so|and|it'?s|is|my|pin|the)$/.test(w));
  const digits = toks.map((w) => (/^\d$/.test(w) ? w : (STRICT_DIGIT[w] ?? (soundAlikes ? SOUND_ALIKE[w] : undefined)))).filter((d): d is string => !!d);
  if (!digits.length || digits.length > 3 || digits.length * 2 < toks.length) return '';
  return digits.join('');
}

/**
 * The same final transcript twice: the transcriber now and then delivers one turn twice (same item, or
 * the same words again, even seconds later, once our reply has started). Answering both cost a second
 * answer said over their next question, or a second PIN try for one mistake. A copy is the same item
 * id, or the same words within DUP_TRANSCRIPT_MS, unless a line of ours since the first asked them to
 * say it again (then a repeat is their answer).
 */
export class TranscriptDeduper {
  private last = { key: '', at: 0 };
  private items: string[] = [];
  isDuplicate(text: string, itemId: string | undefined, now = Date.now(), ourLine: { at: number; text: string } = { at: 0, text: '' }): boolean {
    const key = norm(text);
    if (itemId) {
      if (this.items.includes(itemId)) return true;
      this.items.push(itemId);
      if (this.items.length > 50) this.items.shift();
    }
    if (!key) return false;
    const askedAgain = ourLine.at > this.last.at && ASKS_AGAIN.test(ourLine.text);
    const dup = key === this.last.key && now - this.last.at < DUP_TRANSCRIPT_MS && !askedAgain;
    if (!dup) this.last = { key, at: now };
    return dup;
  }
}

/** Shown in logs instead of a spoken PIN. */
const PIN_SHOWN = '(said the PIN)';
const PIN_TYPED = '(typed the PIN)';
/** "Thanks, bye", "okay that's all, bye-bye": a goodbye at the end of a longer turn. */
const ENDS_WITH_BYE = /\b(?:bye(?:[\s-]bye)?|goodbye)[\s,.!]*$/i;

/** Inbound: Yoshua calling PacePay. The PIN first (said or typed, checked by the server), then questions. */
export class InboundConductor extends Conductor {
  private verified = false;
  /** Utterances that were PIN tries (never shown in logs). */
  private pinTries = new Set<string>();
  private secondPick = 0;
  /** Keypad digits typed so far (never logged), and when the last one came. */
  private keys = '';
  private lastKeyAt = 0;
  private keyTimer?: NodeJS.Timeout;
  /** Last moment anyone was talking or anything was in flight (for the silence hang-up). */
  private lastActivity = Date.now();
  private idleTimer?: NodeJS.Timeout;
  /** A first piece of a PIN said in pieces, waiting for the rest (never logged). */
  private pinPiece = { digits: '', at: 0 };
  private pinPieceTimer?: NodeJS.Timeout;

  constructor(
    port: CallPort,
    private server: VoiceServerClient,
    private callId: string,
    private idleMs = INBOUND_IDLE_MS,
  ) {
    super(port);
    // Short first fillers: a reply ready a moment later never waits behind a long one.
    this.nextFiller = listPicker(INBOUND_FIRST_FILLERS);
    this.idleTimer = setInterval(() => this.checkIdle(), 500);
    this.idleTimer.unref?.();
  }

  protected override fillerAfterMs(): number {
    return INBOUND_FILLER_AFTER_MS;
  }

  protected override laterFillersAfterMs(): number[] {
    return [INBOUND_SECOND_FILLER_AFTER_MS, INBOUND_THIRD_FILLER_AFTER_MS];
  }

  protected override earlyFillerAllowed(): boolean {
    return this.verified && !this.closing;
  }

  protected override secondFiller(): string {
    return INBOUND_SECOND_FILLERS[this.secondPick++ % INBOUND_SECOND_FILLERS.length]!;
  }

  /** Only an exact piece of our own line is echo: a follow-up that shares its words ("...paycheck is late by two days?") is his. */
  protected override isEcho(heard: string, line: string): boolean {
    return isEchoOf(heard, line) && norm(line).includes(norm(heard));
  }

  protected override shown(utterance: string): string {
    if (utterance.includes(KEYPAD)) return PIN_TYPED;
    // Only the outline ("# # # #", "N N N N"), so a misheard PIN can be debugged without the digits.
    if (this.pinTries.has(utterance)) return `${PIN_SHOWN} [${pinShape(utterance)}]`;
    return !this.verified && (/\d/.test(utterance) || !!spokenDigits(utterance)) ? `${PIN_SHOWN} [${pinShape(utterance)}]` : utterance;
  }

  override onUserState(speaking: boolean): void {
    this.lastActivity = Date.now();
    super.onUserState(speaking);
  }

  override onTranscript(text: string): void {
    this.lastActivity = Date.now();
    // "Mm-hm" / "okay" while a lookup runs or a line plays is him listening, not a new question: it
    // must never be merged into the question and asked again (that cost ~4 s and four fillers).
    if (this.verified && (this.busy || this.port.agentSpeaking()) && BACKCHANNEL_WORDS.test(norm(text))) {
      this.port.log(`ignored a backchannel while busy: "${text.trim()}"`);
      return super.onTranscript('');
    }
    super.onTranscript(text);
  }

  /**
   * A keypad digit from the caller (SIP DTMF). Four digits, or # after fewer, are checked exactly like
   * a spoken PIN (same server check, same three tries). * clears. Returns true when this digit sent a
   * PIN to be checked. Digits after the PIN is verified are ignored.
   */
  onKeypad(digit: string): boolean {
    this.lastActivity = Date.now();
    if (this.closing) return false;
    if (this.verified) {
      this.port.log('keypad digit ignored (already verified)');
      return false;
    }
    clearTimeout(this.keyTimer);
    this.lastKeyAt = Date.now();
    if (digit === '*') {
      this.keys = '';
      this.port.log('keypad: cleared');
      return false;
    }
    if (/^[0-9]$/.test(digit)) this.keys += digit;
    if (digit === '#' || this.keys.length >= KEYPAD_PIN_LENGTH) return this.submitKeys();
    this.port.log(`keypad: ${this.keys.length} digit(s) so far`);
    // They stopped typing part-way: check what they typed.
    this.keyTimer = setTimeout(() => void this.submitKeys(), KEYPAD_IDLE_MS);
    this.keyTimer.unref?.();
    return false;
  }

  private submitKeys(): boolean {
    clearTimeout(this.keyTimer);
    const digits = this.keys;
    this.keys = '';
    if (!digits || this.closing || this.verified) return false;
    this.port.log(`keypad: ${digits.length} digit(s) typed, checking`);
    this.pending.push(KEYPAD + digits);
    void this.pump();
    return true;
  }

  /** Nobody has said anything for INBOUND_IDLE_MS: a polite line, then hang up. */
  private checkIdle(): void {
    if (this.closing) return clearInterval(this.idleTimer);
    if (this.busy || this.pending.length || this.keys || this.port.agentSpeaking() || this.port.userSpeaking()) {
      this.lastActivity = Date.now();
      return;
    }
    if (Date.now() - this.lastActivity < this.idleMs) return;
    clearInterval(this.idleTimer);
    this.port.log(`no one has spoken for ${Math.round(this.idleMs / 1000)} s; saying goodbye`);
    void this.close(INBOUND_IDLE_GOODBYE, 'the caller went quiet');
  }

  override stop(): void {
    clearInterval(this.idleTimer);
    clearTimeout(this.keyTimer);
    clearTimeout(this.pinPieceTimer);
    super.stop();
  }

  protected override async answer(utterance: string): Promise<Reply> {
    // A typed PIN (it may share the turn with words said around it: the keypad wins).
    const typed = utterance.indexOf(KEYPAD);
    if (typed >= 0 && !this.verified) return this.checkPin(/^\d*/.exec(utterance.slice(typed + 1))![0], utterance);
    utterance = utterance.split(KEYPAD).join(' ').replace(/\s+/g, ' ').trim();
    const words = norm(utterance).split(' ').filter(Boolean);
    if ((words.length <= 8 && GOODBYE.test(utterance)) || (words.length <= 14 && ENDS_WITH_BYE.test(utterance))) return { say: INBOUND_GOODBYE, next: 'end_call' };
    if (!this.verified) {
      // A PIN said in pieces: "one two" ... "three four" is one try, not two wrong ones.
      const piece = Date.now() - this.pinPiece.at < PIN_FRAGMENT_MS ? this.pinPiece.digits : '';
      this.pinPiece = { digits: '', at: 0 };
      clearTimeout(this.pinPieceTimer);
      let digits = spokenDigits(utterance);
      const frag = digits.length >= KEYPAD_PIN_LENGTH ? '' : pinFragment(utterance, !!piece) || digits;
      if (frag) {
        const sofar = piece + frag;
        if (sofar.length < KEYPAD_PIN_LENGTH) {
          this.pinPiece = { digits: sofar, at: Date.now() };
          this.port.log(`PIN: ${sofar.length} digit(s) so far, waiting for the rest`);
          // Nothing more came: ask for the PIN again (a piece is never counted as a wrong try).
          this.pinPieceTimer = setTimeout(() => {
            if (this.closing || this.verified || !this.pinPiece.digits || this.busy || this.pending.length || this.port.userSpeaking()) return;
            this.pinPiece = { digits: '', at: 0 };
            void this.say(INBOUND_PIN_PROMPT, 'reply');
          }, PIN_FRAGMENT_MS);
          this.pinPieceTimer.unref?.();
          return { say: '', next: 'listen' };
        }
        digits = sofar;
      }
      if (!digits) {
        // They are typing (a key tone heard as a "word"): don't talk over the keypad.
        if (Date.now() - this.lastKeyAt < KEYPAD_IDLE_MS + 1_000) return { say: '', next: 'listen' };
        return isJunk(utterance) ? { say: '', next: 'listen' } : { say: INBOUND_PIN_PROMPT, next: 'listen' };
      }
      return this.checkPin(digits, utterance);
    }
    if (isJunk(utterance)) return { say: '', next: 'listen' };
    const t = utterance.trim();
    if (NO_MORE.test(t)) return { say: INBOUND_GOODBYE, next: 'end_call' };
    if (THANKS.test(t)) return { say: INBOUND_ANYTHING_ELSE, next: 'listen' };
    if (ACK.test(t) || BACKCHANNEL_WORDS.test(norm(t))) return { say: '', next: 'listen' };
    if (YES.test(t)) return { say: INBOUND_GO_AHEAD, next: 'listen' };
    if (ACK_BYE.test(norm(t))) return { say: INBOUND_GOODBYE, next: 'end_call' };
    if (isJailbreak(t)) {
      this.port.log('refused a jailbreak attempt');
      return { say: INBOUND_REFUSAL, next: 'listen' };
    }
    if (isMoveMoney(t)) {
      this.port.log('refused a request to move money');
      return { say: INBOUND_MOVE_MONEY, next: 'listen' };
    }
    // Two words or fewer with no question or topic in them is line noise ("Bye." heard as "5"): never an answer.
    if (words.length <= 2 && !QUESTION_WORD.test(t) && !TOPIC_WORD.test(t)) {
      this.port.log(`not a question, asked again: "${t}"`);
      return { say: INBOUND_DIDNT_CATCH, next: 'listen' };
    }
    const res = await this.server.ask(this.callId, utterance);
    return { say: res.say, next: 'listen' };
  }

  /** One PIN try, said or typed: the server checks it and counts the tries (three, shared). */
  private async checkPin(digits: string, utterance: string): Promise<Reply> {
    this.pinTries.add(utterance);
    const res = await this.server.verifyPin(this.callId, digits);
    if (res.ok) this.verified = true;
    // Three misses: the server says goodbye (and hangs up as a backstop).
    const out = !res.ok && /goodbye/i.test(res.say);
    return { say: res.say, next: out ? 'end_call' : 'listen' };
  }
}
