/**
 * Typed client for the server's voice endpoints (SPEC §4 "Voice worker endpoints"). The voice
 * model only ever sees what these return. Implemented by: voice.
 */
import {
  API,
  DEFAULT_SERVER_URL,
  DecideResultSchema,
  VoiceApprovalResponseSchema,
  VoiceAskResponseSchema,
  VoiceBriefResponseSchema,
  VoiceInboundResponseSchema,
  VoiceVerifyPinResponseSchema,
  type DecideResult,
  type VoiceApprovalResponse,
  type VoiceAskResponse,
  type VoiceBriefResponse,
  type VoiceCallEventRequest,
  type VoiceInboundRequest,
  type VoiceInboundResponse,
  type VoiceVerifyPinResponse,
} from '@pacepay/shared';
import type { z } from 'zod';

export interface VoiceServerClient {
  brief(callId: string): Promise<VoiceBriefResponse>;
  decide(callId: string, utterance: string): Promise<DecideResult>;
  approval(callId: string): Promise<VoiceApprovalResponse>;
  event(callId: string, body: VoiceCallEventRequest): Promise<void>;
  inbound(body: VoiceInboundRequest): Promise<VoiceInboundResponse>;
  verifyPin(callId: string, digits: string): Promise<VoiceVerifyPinResponse>;
  ask(callId: string, question: string): Promise<VoiceAskResponse>;
}

export function createServerClient(baseUrl = process.env.SERVER_URL ?? DEFAULT_SERVER_URL): VoiceServerClient {
  async function call<S extends z.ZodTypeAny | null>(method: 'GET' | 'POST', path: string, schema: S, body?: unknown) {
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
    if (schema === null) return undefined as S extends z.ZodTypeAny ? z.infer<S> : undefined;
    return schema.parse(await res.json()) as S extends z.ZodTypeAny ? z.infer<S> : undefined;
  }
  return {
    brief: (id) => call('GET', API.voice.brief(id), VoiceBriefResponseSchema),
    decide: (id, utterance) => call('POST', API.voice.decide(id), DecideResultSchema, { utterance }),
    approval: (id) => call('POST', API.voice.approval(id), VoiceApprovalResponseSchema, {}),
    event: (id, body) => call('POST', API.voice.events(id), null, body),
    inbound: (body) => call('POST', API.voice.inbound, VoiceInboundResponseSchema, body),
    verifyPin: (id, digits) => call('POST', API.voice.verifyPin(id), VoiceVerifyPinResponseSchema, { digits }),
    ask: (id, question) => call('POST', API.voice.ask(id), VoiceAskResponseSchema, { question }),
  };
}
