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

describe('dead air', () => {
  it('checks in on a quiet line (never the same line twice), then closes neutrally and hangs up', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(() => ({ say: 'Okay, sure.' }));
      const hung = vi.fn(async () => undefined);
      (h.c as unknown as { port: CallPort }).port.hangUp = hung;
      await (h.c as unknown as { port: CallPort }).port.speak('Hi, greeting.', 'greeting');
      h.c.onUserState(true);
      h.c.onUserState(false);
      h.c.onTranscript('Okay, so what can I do for you?');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(h.said).toEqual(['Hi, greeting.', 'Okay, sure.']);
      await vi.advanceTimersByTimeAsync(19_000);
      expect(h.said.at(-1)).toBe('Hello? Are you still there?');
      await vi.advanceTimersByTimeAsync(41_000);
      expect(h.said.slice(2)).toEqual(['Hello? Are you still there?', 'Sorry, are you still on the line?', 'Hi, just checking. Are you still there?']);
      expect(hung).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(22_000);
      expect(h.said.at(-1)).toMatch(/I haven't agreed to any change/);
      expect(hung).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits longer when the lender put PacePay on hold', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(() => ({ say: 'Sure, take your time.' }));
      await (h.c as unknown as { port: CallPort }).port.speak('Hi, greeting.', 'greeting');
      h.c.onUserState(true);
      h.c.onUserState(false);
      h.c.onTranscript('One moment, let me transfer you.');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.said.length).toBe(2);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.said.length).toBe(3);
      h.c.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after two check-ins when nobody ever answered', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(() => ({ say: '' }));
      const hung = vi.fn(async () => undefined);
      (h.c as unknown as { port: CallPort }).port.hangUp = hung;
      await (h.c as unknown as { port: CallPort }).port.speak('Hi, greeting.', 'greeting');
      await vi.advanceTimersByTimeAsync(62_000);
      expect(h.said).toEqual(['Hi, greeting.', 'Hello? Can you hear me?', 'Hello? Is anyone there?', expect.stringMatching(/Nothing has been changed/)]);
      expect(hung).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays in hold mode through hold recordings', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(() => ({ say: '' }));
      await (h.c as unknown as { port: CallPort }).port.speak('Hi, greeting.', 'greeting');
      for (const t of ['Please hold.', 'Your call is important to us. Did you know you can make payments on our app?']) {
        h.c.onUserState(true);
        h.c.onUserState(false);
        h.c.onTranscript(t);
        await vi.advanceTimersByTimeAsync(5_000);
      }
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.said).toEqual(['Hi, greeting.']);
      expect(h.utterances).toEqual(['Please hold.']); // the recording never went to decide
      await vi.advanceTimersByTimeAsync(15_000);
      expect(h.said.at(-1)).toBe("Hi, I'm still on the line whenever you're ready.");
      h.c.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('transfers', () => {
  it('discloses again to a new person after a hold, once', async () => {
    const h = harness((u) => ({ say: /hold/i.test(u) ? 'Sure, take your time.' : "We're hoping to move this month's payment to Friday the 13th, with no fee." }));
    await (h.c as unknown as { port: CallPort }).port.speak("Hi, I'm PacePay, an AI assistant calling on behalf of Yoshua, with Yoshua's permission, about the auto loan ending 4417. This call is transcribed.", 'greeting');
    for (const t of ['Please hold.', 'Thanks for waiting, how can I help?', 'Sorry, how can I help?']) {
      h.c.onUserState(true);
      h.c.onUserState(false);
      h.c.onTranscript(t);
      await tick(5);
    }
    expect(h.said[2]).toBe(
      "Hi, I'm PacePay, an AI assistant calling on Yoshua's behalf, with Yoshua's permission, about the auto loan ending 4417. This call is transcribed. We're hoping to move this month's payment to Friday the 13th, with no fee.",
    );
    expect(h.said[3]).toBe("We're hoping to move this month's payment to Friday the 13th, with no fee.");
    h.c.stop();
  });

  it("completes the server's own re-introduction with the loan ending", async () => {
    const h = harness((u) => ({
      say: /moment/i.test(u) ? 'Take your time.' : "I'm PacePay, an AI assistant calling on Yoshua's behalf, with Yoshua's permission. This call is transcribed. We're hoping to move this month's payment to Friday the 13th, with no fee.",
    }));
    await (h.c as unknown as { port: CallPort }).port.speak("Hi, I'm PacePay, an AI assistant calling on behalf of Yoshua, with Yoshua's permission, about the auto loan ending 4417. This call is transcribed.", 'greeting');
    for (const t of ["Let me get you over to collections, one moment.", 'Collections, this is Marcus, who am I speaking with?']) {
      h.c.onUserState(true);
      h.c.onUserState(false);
      h.c.onTranscript(t);
      await tick(5);
    }
    expect(h.said[2]).toBe(
      "Hi, I'm PacePay, an AI assistant calling on Yoshua's behalf, with Yoshua's permission, about the auto loan ending 4417. This call is transcribed. We're hoping to move this month's payment to Friday the 13th, with no fee.",
    );
    h.c.stop();
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
