/**
 * The turn-taking brain of a call, in code (no model decides anything here). Implemented by: voice.
 *
 * The realtime model only listens: it detects the end of each turn and transcribes it, and never
 * answers on its own (create_response is off and it has no tools). For every final turn of the other
 * person, the Conductor calls the server (decide on an outbound call; verify-pin or ask on an inbound
 * one) and speaks the returned `say` verbatim. Also in code:
 *  - fragments: a turn that arrives while the person is already talking again waits for the rest,
 *    and fragments that arrive while a lookup runs are merged into the next lookup;
 *  - fillers: one short "Mm-hm..." only when a lookup is still running ~1.1 s after they stopped;
 *  - Yoshua's approval: the hold line at once, then polling with short, never-repeated hold updates,
 *    then the approval line exactly once;
 *  - hanging up: only when the server said next=end_call, after the goodbye has fully played.
 */
import type { DecideResult } from '@pacepay/shared';
import type { VoiceExtras, VoiceServerClient } from './server';

export type LineKind = 'greeting' | 'reply' | 'hold' | 'approval' | 'filler' | 'goodbye' | 'prompt';

/** What the Conductor needs from the call (agent.ts wires it to LiveKit; tests can fake it). */
export interface CallPort {
  /**
   * Start speaking `text` exactly. Resolves once it is scheduled; `playout` resolves when it has played
   * (or was cut off); `interrupted()` says whether the other person cut it off.
   */
  speak(text: string, kind: LineKind): Promise<{ playout: Promise<void>; interrupted(): boolean } | undefined>;
  /** True while the other person is talking (their current turn has not ended). */
  userSpeaking(): boolean;
  /** True while PacePay is talking. */
  agentSpeaking(): boolean;
  /** Report the end to the server (once) and hang up. */
  hangUp(reason: string): Promise<void>;
  /** Synthesize lines that may be said soon, so they play at once (optional; failures only cost latency). */
  prepare?(lines: string[]): void;
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
/** The second filler (inbound) never starts sooner than this after the first one did. */
export const SECOND_FILLER_GAP_MS = 1_600;
/** When the person's turn ended but no transcript followed (noise), how long to wait before going on. */
const NO_TRANSCRIPT_MS = 2_200; // transcripts came 1.5-1.9 s after a turn under load
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
  if (/^(uh huh|uhhuh|mm+ hm+|mhm+|mm+hm+|m hm+)$/.test(t)) return false;
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
  private spoken = new Set<string>();
  private lastSpokenAt = 0;
  private lastPlayout: Promise<void> = Promise.resolve();
  /** The last real line, so it can be said again if a noise burst cut it off. */
  private lastLine?: { text: string; kind: LineKind; interrupted(): boolean; resumed: boolean };
  protected nextFiller = fillerPicker();

  constructor(protected port: CallPort) {}

  protected abstract answer(utterance: string): Promise<Reply>;
  /** Whether a filler may play now (no filler while holding for an approval). */
  protected fillerAllowed(): boolean {
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
  /** A second, different filler this long after their turn if the lookup is still running (none by default). */
  protected secondFillerAfterMs(): number | null {
    return null;
  }
  /** The second filler's words (a different line from the first). */
  protected secondFiller(): string {
    return this.nextFiller();
  }

  // -- events from the call ------------------------------------------------------------------

  /** The other person started or stopped talking. */
  onUserState(speaking: boolean): void {
    clearTimeout(this.noTranscriptTimer);
    if (speaking) {
      this.overlapped = this.port.agentSpeaking();
      return;
    }
    this.turnEndedAt = Date.now();
    this.turnsEnded += 1;
    // Noise ends a "turn" with no words: don't wait forever on a transcript that won't come.
    this.noTranscriptTimer = setTimeout(() => {
      this.transcriptsIn = Math.max(this.transcriptsIn, this.turnsEnded); // none is coming
      if (this.port.userSpeaking()) return;
      if (this.held) void this.release();
      else if (this.pending.length) void this.pump();
      else void this.resume();
    }, NO_TRANSCRIPT_MS);
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
    let res: Reply;
    const filler = isShortAnswer(utterance) ? undefined : this.armFiller();
    const t0 = Date.now();
    try {
      res = await this.answer(utterance);
    } catch (err) {
      this.port.log('lookup failed:', (err as Error).message);
      res = { say: LOST_PLACE_LINE, next: 'listen' };
    } finally {
      clearTimeout(filler);
      this.busy = false;
    }
    this.port.log(`t:decided ${Date.now()}`);
    const since = this.turnEndedAt ? Date.now() - this.turnEndedAt : -1;
    this.port.log(`turn ${this.turn}: "${this.shown(utterance)}" -> ${res.next} in ${Date.now() - t0} ms (${since} ms after they stopped)`);
    await this.deliver(res);
    void this.pump();
  }

  /** Speak a reply, unless the person has said more since (then that newer turn gets the answer). */
  private async deliver(res: Reply): Promise<void> {
    if (this.closing) return;
    if (res.next === 'end_call') return this.close(res.say, 'the negotiator closed the call');
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
    this.port.log(`resuming a line cut off by noise: "${l.text}"`);
    await this.say(l.text, l.kind, true);
  }

  /** Hook after a reply (spoken or not): the outbound call starts the approval wait here. */
  protected afterReply(_res: Reply, _spoken: boolean): void {}

  private armFiller(): NodeJS.Timeout | undefined {
    const started = Date.now();
    const anchor = this.turnEndedAt && started - this.turnEndedAt < 5_000 ? this.turnEndedAt : started;
    const delay = Math.max(FILLER_GRACE_MS, anchor + this.fillerAfterMs() - started);
    const turn = this.turn;
    const still = () => this.busy && this.turn === turn && !this.closing && this.fillerAllowed();
    return setTimeout(() => {
      if (!still()) return;
      if (!this.port.agentSpeaking() && !this.port.userSpeaking()) void this.say(this.nextFiller(), 'filler');
      // At most one more, worded differently, if the lookup is still running a while later.
      const second = this.secondFillerAfterMs();
      if (second === null) return;
      const t = setTimeout(() => {
        if (!still() || this.port.agentSpeaking() || this.port.userSpeaking()) return;
        void this.say(this.secondFiller(), 'filler');
      }, Math.max(SECOND_FILLER_GAP_MS, anchor + second - Date.now()));
      t.unref?.();
    }, delay);
  }

  /**
   * The only way a line is spoken. A line is never spoken twice for the same lender turn, whoever
   * asked for it (decide, the approval poll, a hold update); `again` is only for a line cut off by noise.
   */
  protected async say(text: string, kind: LineKind, again = false): Promise<boolean> {
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
    const h = await this.port.speak(t, kind);
    if (h) {
      this.lastPlayout = h.playout;
      void h.playout.then(() => (this.lastSpokenAt = Math.max(this.lastSpokenAt, Date.now())));
      if (kind !== 'filler') this.lastLine = { text: t, kind, interrupted: h.interrupted, resumed: again };
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
  }
}

/** Outbound: PacePay calling the lender. Every lender turn goes to decide. */
export class OutboundConductor extends Conductor {
  private approvalActive = false;
  /** Approval-outcome lines already spoken, whoever (poll or decide) brought them. */
  private approvalSaid = new Set<string>();
  private holds: string[];
  /** Lines the server said may come next, already handed to prepare(). */
  private prepared = new Set<string>();

  constructor(
    port: CallPort,
    private server: VoiceServerClient,
    private callId: string,
    person: string,
  ) {
    super(port);
    this.holds = holdUpdates(person);
  }

  protected override fillerAllowed(): boolean {
    return !this.approvalActive;
  }

  protected override async answer(utterance: string): Promise<Reply> {
    const res: DecideResult & VoiceExtras = await this.server.decide(this.callId, utterance);
    this.prefetch(res.prepare);
    let say = res.say?.trim() ?? '';
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
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i]!;
    if (/^\d$/.test(w)) out.push(w);
    else if (teens[w]) out.push(teens[w]!);
    else if (tens[w]) {
      // "thirty-four" -> 34, a lone "thirty" -> 30.
      const u = unit(toks[i + 1]);
      out.push(tens[w]! + (u ?? '0'));
      if (u) i++;
    } else out.push(words[w] ?? null);
  }
  // Only count number words that sit next to other digits ("to", "for" and "oh" are ordinary words too).
  let best = '';
  let run = '';
  for (const d of out) {
    if (d === null) {
      if (run.length > best.length) best = run;
      run = '';
    } else run += d;
  }
  if (run.length > best.length) best = run;
  return best.length >= 3 ? best : '';
}

const GOODBYE =
  /\b(bye|goodbye|bye bye|that'?s all|that is all|that'?s it|that'?s everything|that'?ll be all|nothing else|hang up|i'?m all set|i'?m good|no thanks|no thank you|talk (?:to you )?(?:later|soon)|see (?:you|ya)|have a good (?:one|day|night))\b/i;
/** After the PIN, a bare "no" / "nope" means nothing else to ask. */
const NO_MORE = /^(?:no|nope|nah|not really|no that'?s it|no i'?m good|nothing)[\s,.!]*$/i;
const THANKS = /^(?:(?:ok(?:ay)?|cool|great|perfect|got it|awesome|alright|all right)[\s,.!]*)?(?:thanks|thank you)(?: so much| very much)?[\s,.!]*$/i;
const ACK = /^(?:ok(?:ay)?|cool|great|perfect|got it|awesome|alright|all right|sounds good|nice|mhm|uh huh|mm hmm)[\s,.!]*$/i;
const YES = /^(?:yes|yeah|yep|yup|sure|ya)[\s,.!]*$/i;
/** A real question has one of these; a two-word "turn" with none is noise ("Bye" heard as "5"). */
const QUESTION_WORD = /\b(what|when|where|why|how|which|who|can|could|should|would|will|is|are|am|do|does|did|was|tell|move|call|pay)\b/i;
const TOPIC_WORD =
  /\b(balance|checking|savings?|paycheck|pay|payday|lender|loan|card|credit|bills?|scores?|money|afford|late|cd|payment|fee|reference|mortgage|rent|debt|cushion|emergency|fund|lowest|deposit|account|car|utilities)\b/i;

export const INBOUND_PIN_PROMPT = 'Sure. First, please say your four-digit PIN.';
export const INBOUND_GOODBYE = 'Okay, talk soon. Bye!';
export const INBOUND_DIDNT_CATCH = "Sorry, I didn't catch that. What would you like to know?";
export const INBOUND_ANYTHING_ELSE = "You're welcome. Anything else?";
export const INBOUND_GO_AHEAD = 'Sure. What would you like to know?';
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
/** Every fixed line of an inbound call, most needed first. */
export const INBOUND_FIXED_LINES = [INBOUND_GREETING, ...INBOUND_SERVER_LINES.slice(0, 2), INBOUND_PIN_PROMPT, INBOUND_GOODBYE, INBOUND_DIDNT_CATCH, ...INBOUND_SERVER_LINES.slice(2), INBOUND_ANYTHING_ELSE, INBOUND_GO_AHEAD];
/** Inbound fillers: the first comes fast (~0.6 s), a second, different one only if the answer is still coming (~2.5 s). */
export const INBOUND_FILLER_AFTER_MS = 600;
export const INBOUND_SECOND_FILLER_AFTER_MS = 2_500;
export const INBOUND_SECOND_FILLERS = ['Still checking, one sec…', 'Almost there…'];
/** Shown in logs instead of a spoken PIN. */
const PIN_SHOWN = '(said the PIN)';

/** Inbound: Yoshua calling PacePay. The PIN first (checked by the server), then questions. */
export class InboundConductor extends Conductor {
  private verified = false;
  /** Utterances that were PIN tries (never shown in logs). */
  private pinTries = new Set<string>();
  private secondPick = 0;

  constructor(
    port: CallPort,
    private server: VoiceServerClient,
    private callId: string,
  ) {
    super(port);
  }

  protected override fillerAfterMs(): number {
    return INBOUND_FILLER_AFTER_MS;
  }

  protected override secondFillerAfterMs(): number | null {
    return INBOUND_SECOND_FILLER_AFTER_MS;
  }

  protected override secondFiller(): string {
    return INBOUND_SECOND_FILLERS[this.secondPick++ % INBOUND_SECOND_FILLERS.length]!;
  }

  /** Only an exact piece of our own line is echo: a follow-up that shares its words ("...paycheck is late by two days?") is his. */
  protected override isEcho(heard: string, line: string): boolean {
    return isEchoOf(heard, line) && norm(line).includes(norm(heard));
  }

  protected override shown(utterance: string): string {
    if (this.pinTries.has(utterance)) return PIN_SHOWN;
    return !this.verified && (/\d/.test(utterance) || !!spokenDigits(utterance)) ? PIN_SHOWN : utterance;
  }

  protected override async answer(utterance: string): Promise<Reply> {
    const words = norm(utterance).split(' ').filter(Boolean);
    if (words.length <= 8 && GOODBYE.test(utterance)) return { say: INBOUND_GOODBYE, next: 'end_call' };
    if (!this.verified) {
      const digits = spokenDigits(utterance);
      if (!digits) return isJunk(utterance) ? { say: '', next: 'listen' } : { say: INBOUND_PIN_PROMPT, next: 'listen' };
      this.pinTries.add(utterance);
      const res = await this.server.verifyPin(this.callId, digits);
      if (res.ok) this.verified = true;
      // Three misses: the server says goodbye (and hangs up as a backstop).
      const out = !res.ok && /goodbye/i.test(res.say);
      return { say: res.say, next: out ? 'end_call' : 'listen' };
    }
    if (isJunk(utterance)) return { say: '', next: 'listen' };
    const t = utterance.trim();
    if (NO_MORE.test(t)) return { say: INBOUND_GOODBYE, next: 'end_call' };
    if (THANKS.test(t)) return { say: INBOUND_ANYTHING_ELSE, next: 'listen' };
    if (ACK.test(t)) return { say: '', next: 'listen' };
    if (YES.test(t)) return { say: INBOUND_GO_AHEAD, next: 'listen' };
    // Two words or fewer with no question or topic in them is line noise ("Bye." heard as "5"): never an answer.
    if (words.length <= 2 && !QUESTION_WORD.test(t) && !TOPIC_WORD.test(t)) {
      this.port.log(`not a question, asked again: "${t}"`);
      return { say: INBOUND_DIDNT_CATCH, next: 'listen' };
    }
    const res = await this.server.ask(this.callId, utterance);
    return { say: res.say, next: 'listen' };
  }
}
