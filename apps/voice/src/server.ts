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

/**
 * Optional fields a server may add to a decide or approval answer; the shared schemas strip unknown
 * keys, so they are read from the raw JSON. Both are optional: an older server just never sends them.
 *  - dtmf: keypad tones to send instead of speaking (an IVR menu: "press 1 for payments").
 *  - prepare: lines that may be said next (read-backs, counters, the approval line), synthesized ahead.
 */
export interface VoiceExtras {
  dtmf?: string;
  prepare?: string[];
}

function extras(raw: unknown): VoiceExtras {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: VoiceExtras = {};
  if (typeof r.dtmf === 'string' && /[0-9*#]/.test(r.dtmf)) out.dtmf = r.dtmf;
  if (Array.isArray(r.prepare)) {
    const lines = r.prepare.filter((l): l is string => typeof l === 'string' && !!l.trim()).slice(0, 8);
    if (lines.length) out.prepare = lines;
  }
  return out;
}

export interface VoiceServerClient {
  brief(callId: string): Promise<VoiceBriefResponse>;
  decide(callId: string, utterance: string): Promise<DecideResult & VoiceExtras>;
  approval(callId: string): Promise<VoiceApprovalResponse & VoiceExtras>;
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
  /** Like call(), keeping the optional extras the schema would strip. */
  async function callX<S extends z.ZodTypeAny>(path: string, schema: S, body: unknown): Promise<z.infer<S> & VoiceExtras> {
    const res = await fetch(new URL(path, baseUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
    const raw = await res.json();
    return Object.assign(schema.parse(raw) as object, extras(raw)) as z.infer<S> & VoiceExtras;
  }
  return {
    brief: (id) => call('GET', API.voice.brief(id), VoiceBriefResponseSchema),
    decide: (id, utterance) => callX(API.voice.decide(id), DecideResultSchema, { utterance }),
    approval: (id) => callX(API.voice.approval(id), VoiceApprovalResponseSchema, {}),
    event: (id, body) => call('POST', API.voice.events(id), null, body),
    inbound: (body) => call('POST', API.voice.inbound, VoiceInboundResponseSchema, body),
    verifyPin: (id, digits) => call('POST', API.voice.verifyPin(id), VoiceVerifyPinResponseSchema, { digits }),
    ask: (id, question) => call('POST', API.voice.ask(id), VoiceAskResponseSchema, { question }),
  };
}
