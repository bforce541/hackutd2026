import { describe, expect, it } from 'vitest';
import { INBOUND_DIDNT_CATCH, INBOUND_GOODBYE, InboundConductor, isEchoOf, spokenDigits, type CallPort } from '../src/conductor';
import { ttsText } from '../src/speech';
import type { VoiceServerClient } from '../src/server';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function harness() {
  const said: { text: string; kind: string }[] = [];
  const asked: string[] = [];
  const pins: string[] = [];
  const logs: string[] = [];
  let hung = false;
  const port: CallPort = {
    speak: async (text, kind) => {
      said.push({ text, kind });
      return { playout: Promise.resolve(), interrupted: () => false };
    },
    userSpeaking: () => false,
    agentSpeaking: () => false,
    hangUp: async () => void (hung = true),
    log: (...a) => void logs.push(a.join(' ')),
  };
  const server = {
    verifyPin: async (_id: string, digits: string) => {
      pins.push(digits);
      return digits === '1234' ? { ok: true, say: 'Thanks, you are verified. What would you like to know?' } : { ok: false, say: 'That PIN did not match. Please say it again.' };
    },
    ask: async (_id: string, q: string) => {
      asked.push(q);
      return { say: `answer to ${q}` };
    },
  } as unknown as VoiceServerClient;
  const c = new InboundConductor(port, server, 'call_1');
  const turn = async (text: string) => {
    c.onUserState(true);
    c.onUserState(false);
    c.onTranscript(text);
    await tick(5);
  };
  return { c, said, asked, pins, logs, turn, hung: () => hung };
}

describe('spokenDigits', () => {
  it.each([
    ['1 2 3 4', '1234'],
    ['One two three four.', '1234'],
    ['Twelve thirty-four.', '1234'],
    ['The PIN is twelve thirty four.', '1234'],
    ['Twelve, thirty-four.', '1234'],
    ['Thirteen thirty-four.', '1334'],
    ['won two three for', '1234'],
    ['go to the store for a bit', ''],
    ['twenty twenty', '2020'],
  ])('%s -> %s', (text, want) => expect(spokenDigits(text)).toBe(want));
});

describe('inbound conductor', () => {
  it('verifies "twelve thirty-four" and never logs the spoken PIN', async () => {
    const h = harness();
    await h.turn('Twelve thirty-four.');
    expect(h.pins).toEqual(['1234']);
    expect(h.logs.join('\n')).not.toMatch(/twelve|1234/i);
  });

  it('treats short noise after the PIN as not a question, and a real bye as goodbye', async () => {
    const h = harness();
    await h.turn('1 2 3 4');
    await h.turn('5');
    expect(h.asked).toEqual([]);
    expect(h.said.at(-1)?.text).toBe(INBOUND_DIDNT_CATCH);
    await h.turn('What did the lender say?');
    expect(h.asked).toEqual(['What did the lender say?']);
    await h.turn('Bye.');
    await tick(1_000);
    expect(h.said.at(-1)?.text).toBe(INBOUND_GOODBYE);
    expect(h.hung()).toBe(true);
  }, 5_000);

  it('only an exact piece of our own line counts as echo', () => {
    const line = 'If your paycheck lands Monday instead of Thursday, checking would hit minus $320 on Friday, November 13th.';
    expect(isEchoOf('checking would hit minus $320 on Friday', line)).toBe(true);
    // The inbound rule also needs the words in order (a follow-up sharing many words is his).
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    expect(norm(line).includes(norm('so what happens if my paycheck is late by two days'))).toBe(false);
  });

  it('reads a reference one character at a time', () => {
    expect(ttsText('The reference number is K7Q2M9.')).toBe('The reference number is K, 7, Q, 2, M, 9.');
  });
});
