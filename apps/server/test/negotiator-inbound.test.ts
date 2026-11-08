/**
 * Inbound call routes (api/voice.ts): the greeting asks to say or type the PIN, /ask never answers
 * before the PIN, and a caller line the worker sends twice is one question and one PIN try.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import * as engine from '@pacepay/engine';
import { createBus } from '../src/bus';
import { createStore } from '../src/store';
import { createConsoleMessaging } from '../src/messaging/console';
import { registerAllTools } from '../src/tools';
import type { ServerContext } from '../src/context';
import { INBOUND_GREETING, voiceRoutes } from '../src/api/voice';
import { nowIso } from '../src/ids';

const PHONE = '+15555550123';
const saved = { phone: process.env.CUSTOMER_PHONE, pin: process.env.INBOUND_PIN };

function setup() {
  const household = structuredClone(engine.fixtures.household);
  const store = createStore({ household, dataDir: mkdtempSync(join(tmpdir(), 'pacepay-inb-')), restore: false, snapshotDelayMs: 0 });
  const bus = createBus();
  let asked = 0;
  const ctx = {
    store,
    bus,
    engine,
    messaging: createConsoleMessaging(() => {}),
    models: {
      chat: async () => {
        asked += 1;
        throw new Error('no model in this test');
      },
      available: () => false,
    },
    dispatch: { hangUp: async () => undefined },
    clock: { today: () => store.day(), now: nowIso },
    enqueue: () => undefined,
  } as unknown as ServerContext;
  const app = new Hono();
  app.route('/api', voiceRoutes(ctx));
  const local = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, local);
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  };
  const event = async (callId: string, body: unknown) =>
    (await app.request(`/api/voice/calls/${callId}/events`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, local)).status;
  return { post, event, store, asked: () => asked };
}

describe('inbound call routes', () => {
  beforeAll(() => {
    registerAllTools();
    process.env.CUSTOMER_PHONE = PHONE;
    process.env.INBOUND_PIN = '1234';
  });
  afterAll(() => {
    if (saved.phone === undefined) delete process.env.CUSTOMER_PHONE;
    else process.env.CUSTOMER_PHONE = saved.phone;
    if (saved.pin === undefined) delete process.env.INBOUND_PIN;
    else process.env.INBOUND_PIN = saved.pin;
  });

  it('greets with "say or type", and asks for the PIN again in the same words', async () => {
    const { post } = setup();
    const call = await post<{ callId: string; greeting: string }>('/api/voice/inbound', { room: 'r1', callerPhone: PHONE });
    expect(call.greeting).toBe(INBOUND_GREETING);
    expect(call.greeting).toMatch(/say or type your four-digit PIN/);
    const wrong = await post<{ ok: boolean; say: string }>(`/api/voice/calls/${call.callId}/verify-pin`, { digits: '9999' });
    expect(wrong).toEqual({ ok: false, say: 'That PIN did not match. Please say or type it again.' });
  });

  it('never answers before the PIN', async () => {
    const { post } = setup();
    const call = await post<{ callId: string }>('/api/voice/inbound', { room: 'r2', callerPhone: PHONE });
    const a = await post<{ say: string }>(`/api/voice/calls/${call.callId}/ask`, { question: "What's my checking balance?" });
    expect(a.say).toMatch(/PIN/);
    expect(a.say).not.toMatch(/\$|\d/);
  });

  it('a duplicated wrong PIN costs one try, not two; the right PIN then verifies', async () => {
    const { post } = setup();
    const call = await post<{ callId: string }>('/api/voice/inbound', { room: 'r3', callerPhone: PHONE });
    const first = await post<{ ok: boolean; say: string }>(`/api/voice/calls/${call.callId}/verify-pin`, { digits: '1235' });
    const dup = await post<{ ok: boolean; say: string }>(`/api/voice/calls/${call.callId}/verify-pin`, { digits: '1235' });
    expect(first.say).toMatch(/did not match/);
    expect(dup).toEqual({ ok: false, say: '' });
    const second = await post<{ ok: boolean; say: string }>(`/api/voice/calls/${call.callId}/verify-pin`, { digits: '1236' });
    expect(second.say).toMatch(/did not match/); // try 2 of 3, not the goodbye
    const right = await post<{ ok: boolean; say: string }>(`/api/voice/calls/${call.callId}/verify-pin`, { digits: '1234' });
    expect(right.ok).toBe(true);
    const again = await post<{ ok: boolean; say: string }>(`/api/voice/calls/${call.callId}/verify-pin`, { digits: '1234' });
    expect(again).toEqual({ ok: true, say: '' });
  });

  it('a duplicated question is answered once; the PIN said again is not a question and is redacted', async () => {
    const { post, event, store } = setup();
    const call = await post<{ callId: string }>('/api/voice/inbound', { room: 'r4', callerPhone: PHONE });
    await post(`/api/voice/calls/${call.callId}/verify-pin`, { digits: '1234' });
    const q = 'How am I doing financially?';
    const [a, b] = await Promise.all([
      post<{ say: string }>(`/api/voice/calls/${call.callId}/ask`, { question: q }),
      post<{ say: string }>(`/api/voice/calls/${call.callId}/ask`, { question: 'how am I doing financially' }),
    ]);
    expect([a.say, b.say].filter((s) => s !== '')).toHaveLength(1);
    const pin = await post<{ say: string }>(`/api/voice/calls/${call.callId}/ask`, { question: '1-2-3-4.' });
    expect(pin.say).toBe('');
    // Long after verification, the PIN line in the transcript is still redacted.
    await new Promise((r) => setTimeout(r, 2_100));
    expect(await event(call.callId, { type: 'transcript', speaker: 'customer', text: 'one two three four' })).toBe(204);
    const lines = store.mustGet('calls', call.callId).transcript.map((l) => l.text);
    expect(lines.join(' ')).not.toMatch(/one two three four/);
  });
});
