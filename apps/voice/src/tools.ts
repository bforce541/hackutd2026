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
}

export function outboundTools(server: VoiceServerClient, callId: string, hooks: VoiceToolHooks) {
  return {
    decide: llm.tool({
      name: 'decide',
      description: "Call after the other person says anything about a date, an amount, a fee, verifying identity, or saying no. Speak the returned 'say' text exactly.",
      parameters: z.object({ utterance: z.string().describe("The other person's exact words") }),
      execute: async ({ utterance }) => server.decide(callId, utterance),
    }),
    await_approval: llm.tool({
      name: 'await_approval',
      description: "Call when decide returned next=await_approval, after saying its line. Waits for Yoshua's answer.",
      parameters: z.object({}),
      execute: async () => {
        void hooks;
        throw new Error('voice.await_approval: not implemented yet');
      },
    }),
    end_call: llm.tool({
      name: 'end_call',
      description: 'End the call after saying goodbye.',
      parameters: z.object({ reason: z.string() }),
      execute: async () => {
        throw new Error('voice.end_call: not implemented yet');
      },
    }),
  };
}

export function inboundTools(server: VoiceServerClient, callId: string, hooks: VoiceToolHooks) {
  return {
    verify_pin: llm.tool({
      name: 'verify_pin',
      description: "Check the caller's spoken PIN digits. Speak the returned 'say' text exactly.",
      parameters: z.object({ digits: z.string().describe('The digits as spoken, e.g. "1234"') }),
      execute: async ({ digits }) => server.verifyPin(callId, digits),
    }),
    ask_pacepay: llm.tool({
      name: 'ask_pacepay',
      description: "Answer the caller's question. Speak the returned 'say' text exactly.",
      parameters: z.object({ question: z.string() }),
      execute: async ({ question }) => server.ask(callId, question),
    }),
    end_call: llm.tool({
      name: 'end_call',
      description: 'End the call after saying goodbye.',
      parameters: z.object({ reason: z.string() }),
      execute: async () => {
        void hooks;
        throw new Error('voice.end_call: not implemented yet');
      },
    }),
  };
}
