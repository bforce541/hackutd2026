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
  /** Tell the server the call ended (posts /events {ended}), once. */
  end(reason: string): Promise<void>;
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

async function endCall(hooks: VoiceToolHooks, reason: string) {
  // Let the goodbye finish, then report and hang up.
  setTimeout(() => {
    void hooks.end(reason).then(() => hooks.hangUp()).catch((err) => console.error('[voice] end_call failed', (err as Error).message));
  }, 1_500);
  return { ok: true };
}

export function outboundTools(server: VoiceServerClient, callId: string, hooks: VoiceToolHooks) {
  return {
    decide: llm.tool({
      name: 'decide',
      description: "Call after the other person says anything about a date, an amount, a fee, verifying identity, or saying no. Speak the returned 'say' text exactly.",
      parameters: z.object({ utterance: z.string().describe("The other person's exact words") }),
      execute: async ({ utterance }) => {
        try {
          return await server.decide(callId, utterance);
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
      execute: async () => awaitApproval(server, callId, hooks),
    }),
    end_call: llm.tool({
      name: 'end_call',
      description: 'End the call after saying goodbye.',
      parameters: z.object({ reason: z.string() }),
      execute: async ({ reason }) => endCall(hooks, reason),
    }),
  };
}

export function inboundTools(server: VoiceServerClient, callId: string, hooks: VoiceToolHooks) {
  return {
    verify_pin: llm.tool({
      name: 'verify_pin',
      description: "Check the caller's spoken PIN digits. Speak the returned 'say' text exactly.",
      parameters: z.object({ digits: z.string().describe('The digits as spoken, e.g. "1234"') }),
      execute: async ({ digits }) => {
        try {
          return await server.verifyPin(callId, digits);
        } catch (err) {
          console.error('[voice] verify_pin failed', (err as Error).message);
          return { ok: false, say: 'Sorry, I could not check that. Please say the PIN again.' };
        }
      },
    }),
    ask_pacepay: llm.tool({
      name: 'ask_pacepay',
      description: "Answer the caller's question. Speak the returned 'say' text exactly.",
      parameters: z.object({ question: z.string() }),
      execute: async ({ question }) => {
        try {
          return await server.ask(callId, question);
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
