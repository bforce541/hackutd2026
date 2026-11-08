/**
 * The voice tools (SPEC §7.2). Each one calls a server endpoint through VoiceServerClient.
 * Implemented by: voice.
 *
 * | Tool            | Endpoint                                  | Notes |
 * | decide          | POST /api/voice/calls/:id/decide          | after every lender turn about a date, money, a fee, verification or refusal; speak `say` word for word |
 * | await_approval  | polls POST /api/voice/calls/:id/approval  | every 2 s for up to 60 s; at 20 s and 40 s say 'Thanks for holding, still checking with Yoshua.' |
 * | end_call        | POST /api/voice/calls/:id/events {ended}  | then delete the room to hang up |
 * | verify_pin      | POST /api/voice/calls/:id/verify-pin      | inbound only |
 * | ask_pacepay     | POST /api/voice/calls/:id/ask             | inbound only, after the PIN |
 *
 * Fillers are chosen here, in code, never by the model: if decide (or an inbound lookup) is still
 * running ~1.1 s after the other person stopped talking, one short filler plays, varied and never the
 * same twice in a row. A fast answer gets no filler at all.
 */
import { llm } from '@livekit/agents';
import { z } from 'zod';
import type { VoiceServerClient } from './server';

export const APPROVAL_POLL_MS = 2_000;
export const APPROVAL_MAX_MS = 60_000;
export const HOLD_LINE = 'Thanks for holding, still checking with Yoshua.';

export interface VoiceToolHooks {
  /** Speak a line outside the model's turn (session.say). */
  say(text: string): Promise<void>;
  /** Hang up: delete the LiveKit room. */
  hangUp(): Promise<void>;
  /** Resolve once the agent has finished speaking (or after maxMs). Optional: tests may omit it. */
  settle?(maxMs: number): Promise<void>;
  /** Tell the server the call ended (posts /events {ended}), once. */
  end(reason: string): Promise<void>;
  /** Speak a short filler while a tool is still working. Optional: tests may omit it. */
  filler?(text: string): Promise<void>;
  /** When the other person's last turn ended (ms epoch), or 0 if unknown. */
  turnEndedAt?(): number;
}

/** Silence after the other person's turn before a filler plays. */
export const FILLER_AFTER_MS = 1_100;
/** Even when the turn ended long ago, give a just-started lookup this long to answer first. */
export const FILLER_GRACE_MS = 250;
/** A turn end older than this belongs to an earlier turn; time from the tool start instead. */
const TURN_END_STALE_MS = 5_000;

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

/**
 * Run a lookup; if it has not returned ~FILLER_AFTER_MS after the other person's turn ended, play one
 * filler. The timer is anchored on the turn end when we know it, otherwise on the tool start.
 */
async function withFiller<T>(hooks: VoiceToolHooks, nextFiller: () => string, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const turnEnd = hooks.turnEndedAt?.() ?? 0;
  const anchor = turnEnd && started - turnEnd < TURN_END_STALE_MS ? turnEnd : started;
  const delay = Math.max(FILLER_GRACE_MS, anchor + FILLER_AFTER_MS - started);
  const timer = hooks.filler
    ? setTimeout(() => void hooks.filler!(nextFiller()).catch(() => undefined), delay)
    : undefined;
  try {
    return await work();
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls the server every 2 s for up to 60 s; says the hold line at 20 s and 40 s. */
export async function awaitApproval(server: VoiceServerClient, callId: string, hooks: VoiceToolHooks) {
  const started = Date.now();
  const holdAt = [20_000, 40_000];
  let said = 0;
  for (;;) {
    let res;
    try {
      res = await server.approval(callId);
    } catch (err) {
      console.error('[voice] approval poll failed', (err as Error).message);
    }
    if (res && res.status !== 'pending') {
      return { status: res.status, say: res.say ?? '', next: res.next ?? 'listen' };
    }
    const elapsed = Date.now() - started;
    if (elapsed >= APPROVAL_MAX_MS) break;
    if (said < holdAt.length && elapsed >= holdAt[said]!) {
      said += 1;
      await hooks.say(HOLD_LINE).catch(() => undefined);
    }
    await sleep(APPROVAL_POLL_MS);
  }
  // The server times the approval out itself at 60 s; one last look, then a safe fallback.
  try {
    const last = await server.approval(callId);
    if (last.status !== 'pending') return { status: last.status, say: last.say ?? '', next: last.next ?? 'listen' };
  } catch {
    /* fall through */
  }
  return {
    status: 'timeout' as const,
    say: 'I have not heard back yet. Could you hold that offer and give me a reference number? I will follow up.',
    next: 'end_call' as const,
  };
}

export const END_TAIL_MS = 800;
export const END_MAX_MS = 12_000;

async function endCall(hooks: VoiceToolHooks, reason: string) {
  // Detached so the tool result returns at once and the model can speak its goodbye. Then wait for
  // that speech to play out fully, add a short tail, report and hang up (hard cap on the wait).
  void (async () => {
    await hooks.settle?.(END_MAX_MS);
    await sleep(END_TAIL_MS);
    await hooks.end(reason);
    await hooks.hangUp();
  })().catch((err) => console.error('[voice] end_call failed', (err as Error).message));
  return { ok: true };
}

export function outboundTools(server: VoiceServerClient, callId: string, hooks: VoiceToolHooks) {
  // The model may only hang up after the negotiator (decide or the approval poll) said next=end_call.
  let mayEnd = false;
  const nextFiller = fillerPicker();
  const track = <T extends { next?: string }>(res: T): T => {
    if (res.next === 'end_call') mayEnd = true;
    return res;
  };
  return {
    decide: llm.tool({
      name: 'decide',
      description: "Call after EVERY turn of the other person that is real English speech (not noise), straight away and without speaking first. Pass their exact words. Then say the returned 'say' text word for word, warmly and conversationally, never improvising or adding filler; if it is empty, stay silent.",
      parameters: z.object({ utterance: z.string().describe("The other person's exact words") }),
      execute: async ({ utterance }) => {
        try {
          const res = track(await withFiller(hooks, nextFiller, () => server.decide(callId, utterance)));
          // Nothing to say means silence: make that unmistakable to the model.
          return res.say?.trim() ? res : { ...res, say: '', note: 'Nothing to say. Stay silent and listen.' };
        } catch (err) {
          console.error('[voice] decide failed', (err as Error).message);
          return { say: 'Sorry, I lost my place for a moment. Could you say that again?', next: 'listen' as const };
        }
      },
    }),
    await_approval: llm.tool({
      name: 'await_approval',
      description: "Call when decide returned next=await_approval, after saying its line. Waits for Yoshua's answer.",
      parameters: z.object({}),
      execute: async () => track(await awaitApproval(server, callId, hooks)),
    }),
    end_call: llm.tool({
      name: 'end_call',
      description: 'End the call. Only allowed after decide or await_approval returned next=end_call.',
      parameters: z.object({ reason: z.string() }),
      execute: async ({ reason }) => {
        if (!mayEnd) {
          console.warn('[voice] end_call refused: the negotiator has not closed the call', reason);
          return { ok: false, note: 'Not allowed yet. Do not hang up. Stay on the line, keep listening, and call decide on the next turn.' };
        }
        return endCall(hooks, reason);
      },
    }),
  };
}

export function inboundTools(server: VoiceServerClient, callId: string, hooks: VoiceToolHooks) {
  const nextFiller = fillerPicker();
  return {
    verify_pin: llm.tool({
      name: 'verify_pin',
      description: "Check the caller's spoken PIN digits, without speaking first. Then speak the returned 'say' text exactly, warmly and conversationally.",
      parameters: z.object({ digits: z.string().describe('The digits as spoken, e.g. "1234"') }),
      execute: async ({ digits }) => {
        try {
          return await withFiller(hooks, nextFiller, () => server.verifyPin(callId, digits));
        } catch (err) {
          console.error('[voice] verify_pin failed', (err as Error).message);
          return { ok: false, say: 'Sorry, I could not check that. Please say the PIN again.' };
        }
      },
    }),
    ask_pacepay: llm.tool({
      name: 'ask_pacepay',
      description: "Answer the caller's question, without speaking first. Then speak the returned 'say' text exactly, warmly and conversationally.",
      parameters: z.object({ question: z.string() }),
      execute: async ({ question }) => {
        try {
          return await withFiller(hooks, nextFiller, () => server.ask(callId, question));
        } catch (err) {
          console.error('[voice] ask_pacepay failed', (err as Error).message);
          return { say: 'Sorry, I could not look that up right now.' };
        }
      },
    }),
    end_call: llm.tool({
      name: 'end_call',
      description: 'End the call after saying goodbye.',
      parameters: z.object({ reason: z.string() }),
      execute: async ({ reason }) => endCall(hooks, reason),
    }),
  };
}
