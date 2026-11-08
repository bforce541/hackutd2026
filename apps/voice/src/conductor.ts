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
import type { VoiceServerClient } from './server';

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
  log(...a: unknown[]): void;
}

/** Silence after the other person's turn before a filler plays. */
export const FILLER_AFTER_MS = 1_100;
/** Even when the turn ended long ago, give a just-started lookup this long to answer first. */
export const FILLER_GRACE_MS = 250;
/** When the person's turn ended but no transcript followed (noise), how long to wait before going on. */
const NO_TRANSCRIPT_MS = 1_500;
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
 * Lines the negotiator often says right after a short lender turn (the hold line after "yes" above
 * all). Synthesized ahead so they start at once; a wording change on the server only costs latency.
 */
export function likelyLines(person: string): string[] {
  return [
    `Let me confirm that with ${person}.`,
    `Great, let me run that by ${person} real quick.`,
    `Okay, I'll check with ${person}. Bear with me.`,
    `Thanks. Let me get ${person}'s okay on that.`,
    'Sure, take your time.',
    "No problem, I'll hold.",
    'Of course, take your time.',
    'Sorry, could you say that again?',
    "Sorry, I didn't catch that. Could you say it again?",
    LOST_PLACE_LINE,
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

  // -- events from the call ------------------------------------------------------------------

  /** The other person started or stopped talking. */
  onUserState(speaking: boolean): void {
    clearTimeout(this.noTranscriptTimer);
    if (speaking) {
      this.overlapped = this.port.agentSpeaking();
      return;
    }
    this.turnEndedAt = Date.now();
    // Noise ends a "turn" with no words: don't wait forever on a transcript that won't come.
    this.noTranscriptTimer = setTimeout(() => {
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
    const t = text.trim();
    let words = !!t && !isJunk(t);
    if (words && this.overlapped && this.lastLine && isEchoOf(t, this.lastLine.text)) {
      this.port.log(`ignored our own voice coming back: "${t}"`);
      words = false;
    }
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
    const since = this.turnEndedAt ? Date.now() - this.turnEndedAt : -1;
    this.port.log(`turn ${this.turn}: "${utterance}" -> ${res.next} in ${Date.now() - t0} ms (${since} ms after they stopped)`);
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
    if (this.port.userSpeaking() && res.say) {
      this.held = res;
      this.afterReply(res, false);
      return;
    }
    if (res.say) await this.say(res.say, res.next === 'await_approval' ? 'hold' : 'reply');
    this.afterReply(res, true);
  }

  private async release(): Promise<void> {
    const r = this.held;
    this.held = undefined;
    if (r && !this.closing && !this.busy) await this.say(r.say, r.next === 'await_approval' ? 'hold' : 'reply');
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
    const delay = Math.max(FILLER_GRACE_MS, anchor + FILLER_AFTER_MS - started);
    return setTimeout(() => {
      if (!this.busy || this.closing || !this.fillerAllowed()) return;
      if (this.port.agentSpeaking() || this.port.userSpeaking()) return;
      void this.say(this.nextFiller(), 'filler');
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
    const res: DecideResult = await this.server.decide(this.callId, utterance);
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
    return { say, next: res.next };
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
      if (out?.status === 'pending' && out.prepare?.length) {
        const fresh = out.prepare.filter((l) => !this.prepared.has(l));
        fresh.forEach((l) => this.prepared.add(l));
        if (fresh.length) this.port.prepare?.(fresh);
      }
      if (out && out.status !== 'pending') {
        this.approvalActive = false;
        const say = out.say?.trim() ?? '';
        const fresh = !!say && !this.approvalSaid.has(norm(say));
        if (say) this.approvalSaid.add(norm(say));
        if (out.next === 'end_call') return this.close(fresh ? say : '', `approval ${out.status}`);
        // Wait for the lender to finish a sentence and for any lookup in flight.
        for (let i = 0; i < 50 && (this.port.userSpeaking() || this.busy); i++) await sleep(100);
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

/** Spoken PIN digits: "one two three four", "1 2 3 4", "twelve thirty four" is rare and left alone. */
export function spokenDigits(text: string): string {
  const words: Record<string, string> = {
    zero: '0', oh: '0', o: '0', one: '1', won: '1', two: '2', to: '2', too: '2', three: '3', four: '4', for: '4',
    five: '5', six: '6', seven: '7', eight: '8', ate: '8', nine: '9',
  };
  const toks = text.toLowerCase().replace(/(\d)/g, ' $1 ').split(/[^a-z0-9]+/).filter(Boolean);
  const out = toks.map((w) => (/^\d$/.test(w) ? w : words[w] ?? null));
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

const GOODBYE = /\b(bye|goodbye|that'?s all|that is all|that'?s it|nothing else|hang up)\b/i;
export const INBOUND_PIN_PROMPT = 'Sure. First, please say your four-digit PIN.';
export const INBOUND_GOODBYE = 'Okay, talk soon. Bye!';

/** Inbound: Yoshua calling PacePay. The PIN first (checked by the server), then questions. */
export class InboundConductor extends Conductor {
  private verified = false;

  constructor(
    port: CallPort,
    private server: VoiceServerClient,
    private callId: string,
  ) {
    super(port);
  }

  protected override async answer(utterance: string): Promise<Reply> {
    const short = utterance.split(/\s+/).length <= 8;
    if (short && GOODBYE.test(utterance)) return { say: INBOUND_GOODBYE, next: 'end_call' };
    if (!this.verified) {
      const digits = spokenDigits(utterance);
      if (!digits) return isJunk(utterance) ? { say: '', next: 'listen' } : { say: INBOUND_PIN_PROMPT, next: 'listen' };
      const res = await this.server.verifyPin(this.callId, digits);
      if (res.ok) this.verified = true;
      // Three misses: the server says goodbye (and hangs up as a backstop).
      const out = !res.ok && /goodbye/i.test(res.say);
      return { say: res.say, next: out ? 'end_call' : 'listen' };
    }
    if (isJunk(utterance)) return { say: '', next: 'listen' };
    const res = await this.server.ask(this.callId, utterance);
    return { say: res.say, next: 'listen' };
  }
}
