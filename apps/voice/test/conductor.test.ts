import { describe, expect, it, vi } from 'vitest';
import { OutboundConductor, targetDayLines, type CallPort } from '../src/conductor';
import { ttsText } from '../src/speech';
import type { VoiceServerClient } from '../src/server';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function harness(decide: (u: string) => Record<string, unknown>) {
  const said: string[] = [];
  const tones: string[] = [];
  let speaking = false;
  const port: CallPort = {
    speak: async (text) => {
      said.push(text);
      return { playout: Promise.resolve(), interrupted: () => false };
    },
    userSpeaking: () => speaking,
    agentSpeaking: () => false,
    hangUp: async () => undefined,
    sendDtmf: async (d) => {
      tones.push(d);
      return true;
    },
    log: () => undefined,
  };
  const utterances: string[] = [];
  const server = {
    decide: async (_id: string, u: string) => {
      utterances.push(u);
      return { say: '', next: 'listen', state: 'listening', ...decide(u) };
    },
    approval: async () => ({ status: 'pending' }),
  } as unknown as VoiceServerClient;
  const c = new OutboundConductor(port, server, 'call_1', 'Yoshua');
  return { c, said, tones, utterances, setSpeaking: (v: boolean) => (speaking = v) };
}

describe('conductor', () => {
  it('ignores a word-for-word repeat of a short answer right after it (no phantom second yes)', async () => {
    const h = harness((u) => ({ say: `heard ${u}` }));
    h.c.onUserState(true);
    h.c.onUserState(false);
    h.c.onTranscript('Yeah.');
    await tick(5);
    h.c.onUserState(true);
    h.c.onUserState(false);
    h.c.onTranscript('Yeah.');
    await tick(5);
    expect(h.utterances).toEqual(['Yeah.']);
  });

  it('waits for a later piece still being transcribed, then answers all of it once', async () => {
    const h = harness((u) => ({ say: `heard ${u}` }));
    h.c.onUserState(true);
    h.c.onUserState(false); // "Okay,"
    h.c.onUserState(true);
    h.c.onUserState(false); // "your reference number is A 7 7 3 2."
    h.c.onTranscript('Okay.');
    await tick(5);
    expect(h.said).toEqual([]); // held: the second piece is not transcribed yet
    h.c.onTranscript('Your reference number is A7732.');
    await tick(5);
    expect(h.utterances.at(-1)).toBe('Okay. Your reference number is A7732.');
    expect(h.said).toEqual(['heard Okay. Your reference number is A7732.']);
  });

  it('sends keypad tones instead of speaking when decide carries dtmf, and speaks without it', async () => {
    const h = harness((u) => (/press/.test(u) ? { say: 'Representative.', dtmf: '1' } : { say: 'Hello.' }));
    h.c.onUserState(true);
    h.c.onUserState(false);
    h.c.onTranscript('For payments, press 1.');
    await tick(5);
    expect(h.tones).toEqual(['1']);
    expect(h.said).toEqual([]);
    h.c.onUserState(true);
    h.c.onUserState(false);
    h.c.onTranscript('Hi, this is Sam.');
    await tick(5);
    expect(h.said).toEqual(['Hello.']);
  });

  it('hands decide prepare lines to the port once', async () => {
    const h = harness(() => ({ say: 'Okay.', prepare: ['A line.', 'B line.'] }));
    const prepare = vi.fn();
    (h.c as unknown as { port: CallPort }).port.prepare = prepare;
    for (const t of ['one', 'two']) {
      h.c.onUserState(true);
      h.c.onUserState(false);
      h.c.onTranscript(t);
      await tick(5);
    }
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(['A line.', 'B line.']);
  });
});

describe('lines', () => {
  it('reads the asked-for day from the greeting', () => {
    const lines = targetDayLines("I'm calling to ask if this month's payment can move to Friday, November 13th, with no fee.");
    expect(lines).toContain("Okay, so just to confirm, that's Friday the 13th with no fee?");
    expect(lines).toContain('Could we do Friday the 13th instead, with no fee?');
    expect(targetDayLines('Hello.')).toEqual([]);
  });

  it('respells the name for TTS only', () => {
    expect(ttsText("Thanks. Let me get Yoshua's okay on that.")).toBe("Thanks. Let me get Yaw-shoo-uh's okay on that.");
  });
});
