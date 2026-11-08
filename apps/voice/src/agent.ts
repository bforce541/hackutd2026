/**
 * The LiveKit Agents worker (SPEC §7.2). Implemented by: voice.
 * Run: `pnpm --filter @pacepay/voice dev` (through dotenvx; needs LIVEKIT_* and OPENAI_API_KEY).
 *
 * Code drives every turn; no model ever chooses PacePay's words:
 *  - The realtime model (OPENAI_REALTIME_MODEL, falling back to gpt-realtime-2, then gpt-realtime) only
 *    listens: server VAD ends each turn and transcribes it, with create_response off and no tools, so
 *    it never answers on its own.
 *  - conductor.ts takes each final turn to the server (decide; verify-pin / ask on inbound calls) and
 *    speech.ts speaks the returned `say` verbatim with TTS (voice marin).
 * Outbound: the job's metadata is { callId }; fetch the brief, open with its greeting once the lender
 * picks up, post every transcript line to /events. Inbound: no metadata; read the caller's number from
 * the SIP participant attributes (sip.phoneNumber), POST /api/voice/inbound, then the PIN flow.
 */
import { cli, defineAgent, ServerOptions, voice, type JobContext } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { RoomServiceClient } from 'livekit-server-sdk';
import { ParticipantKind, RoomEvent, type AudioFrame, type RemoteParticipant } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Speaker } from '@pacepay/shared';
import { createServerClient, type VoiceServerClient } from './server';
import { sendDtmf } from './dtmf';
import { FILLERS, holdUpdates, INBOUND_FIRST_FILLERS, INBOUND_FIXED_LINES, INBOUND_IDLE_GOODBYE, INBOUND_SECOND_FILLERS, InboundConductor, isEchoOf, isJunk, likelyLines, OutboundConductor, targetDayLines, TranscriptDeduper, type CallPort, type Conductor, type LineKind, type SpokenLine } from './conductor';
import { audioFor, bakedClips, isReady, lastTtsInfo, prewarm, startLine, type LineAudio } from './speech';

export const AGENT_NAME = process.env.PACEPAY_VOICE_AGENT_NAME || 'pacepay-voice';
const MODEL_FALLBACKS = ['gpt-realtime-2.1', 'gpt-realtime-2', 'gpt-realtime'];
const log = (...a: unknown[]) => console.log(new Date().toISOString(), '[voice]', ...a);
/** Timing marks for the test harness (t:<name> <epoch ms> <extra>); one short line each. */
const mark = (name: string, extra = '') => log(`t:${name} ${Date.now()}${extra ? ` ${extra}` : ''}`);

/** Only used if TTS is down: the realtime model reads the line instead (no tools, exact words). */
const LISTENER_INSTRUCTIONS =
  'You are the voice of PacePay on a phone call. You never choose words yourself: you only ever say the exact ' +
  'line you are given, word for word, warmly and naturally, like a relaxed person on the phone. Never add, ' +
  'remove or rephrase anything, never answer the other person on your own, never ask questions of your own.';
const EXACT = (text: string) => `Say exactly this and nothing else, then stop: "${text}"`;

/**
 * Phone-line turn-taking. Server VAD is less jumpy than semantic VAD on 8 kHz line noise and echo: a
 * 0.7 threshold, 300 ms of audio kept before speech, 450 ms of silence to end a turn (a
 * sentence split at a pause is merged back by the Conductor). Measured on the synthetic lender: 350 ms
 * saved ~100 ms but split one-word answers, and the transcriber turned the tail into a second "Yeah."
 * (a phantom yes); 400 ms split "Okay, ... your reference number is"; 450 ms split nothing. create_response
 * is off: the model never answers by itself; the Conductor decides what is said.
 */
const PHONE_TURN_DETECTION = {
  type: 'server_vad' as const,
  threshold: 0.7,
  prefix_padding_ms: 300,
  silence_duration_ms: Number(process.env.PACEPAY_VOICE_SILENCE_MS) || 450,
  create_response: false,
  interrupt_response: false,
};
const PHONE_NOISE_REDUCTION = { type: 'near_field' as const };
const PHONE_TRANSCRIPTION = {
  model: process.env.PACEPAY_VOICE_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
  language: 'en',
  prompt:
    'A short phone call in English between an assistant and a loan servicer about a payment date, a fee and a ' +
    'reference number. Reference numbers are read out as single letters and digits, like "A 7 7 3 2".',
};
/**
 * Yoshua calling PacePay: a PIN, short money questions, a goodbye. The lender prompt above pushes short
 * words toward letters and digits ("Bye." came out as "5"). The example digits are not the PIN.
 */
const INBOUND_TRANSCRIPTION = {
  ...PHONE_TRANSCRIPTION,
  // Short on purpose: a long prompt full of example questions came back as a "transcript" of silence.
  prompt: 'Yoshua phones his money assistant: a four-digit PIN, short money questions, then bye.',
};

const wordsOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
/** The transcriber now and then "hears" its own prompt in silence or noise: never a turn. */
function isPromptLeak(transcript: string): boolean {
  const w = wordsOf(transcript);
  if (w.length < 5) return false;
  return [PHONE_TRANSCRIPTION.prompt, INBOUND_TRANSCRIPTION.prompt].some((p) => {
    const pw = wordsOf(p).join(' ');
    let hits = 0;
    for (let i = 0; i + 3 <= w.length; i++) if (pw.includes(w.slice(i, i + 3).join(' '))) hits++;
    return hits / (w.length - 2) >= 0.6;
  });
}

function modelOrder(): string[] {
  const preferred = process.env.OPENAI_REALTIME_MODEL;
  return [...new Set([preferred, ...MODEL_FALLBACKS].filter((m): m is string => !!m))];
}

function roomClient(): RoomServiceClient {
  const e = process.env;
  return new RoomServiceClient(e.LIVEKIT_URL!.replace(/^wss:/, 'https:'), e.LIVEKIT_API_KEY!, e.LIVEKIT_API_SECRET!);
}

/**
 * Talking over PacePay. The framework would cut a line the instant its VAD hears anything (a cough, a
 * door, chatter in the room, the line's own echo) and the line was then said again from the start: the
 * "restarting" heard on real calls. Now only these cut a line (wire() does it, never the framework):
 *  - they keep talking for BARGE_MS while PacePay talks (a real barge-in: "sorry, hang on..."). The VAD
 *    holds "speaking" ~450 ms past the last word, so 1.2 s is ~0.8 s of actual speech: a "yeah" or
 *    "mm-hm" over a line (700 ms cut one and the line restarted) never cuts it;
 *  - their words come back and are a real turn (not "mm-hm", not our own line echoed).
 * A line cut by what turns out to be noise carries on from where it stopped (Conductor.resume).
 */
export const BARGE_MS = Number(process.env.PACEPAY_VOICE_BARGE_MS) || 1_200;
/** Inbound: the greeting starts no sooner than this after the caller joins. */
const GREETING_SETTLE_MS = 800;
/** A line waits at most this long for them to stop talking before it starts. */
const WAIT_FOR_QUIET_MS = 4_000;
/** Audio the source holds ahead of playout: room for a slow event-loop tick without a gap mid-line. */
const OUTPUT_QUEUE_MS = 400;
const BACKCHANNEL =
  /^(?:(?:ok(?:ay)?|mhm+|mm+ ?hm+|uh ?huh|a+ ?ha+|ah+|oh+|hm+|mm+|uh+|um+|yeah|yes|yep|yup|right|sure|got it|gotcha|cool|great|perfect|nice|thanks|thank you|alright|all right|i see|wow)[ ,.!?]*)+$/;

/** Start the listening session, trying each realtime model in turn if one is not available. */
async function startSession(
  ctx: JobContext,
  transcription: typeof PHONE_TRANSCRIPTION = PHONE_TRANSCRIPTION,
  /** Inbound: hear the caller even over the greeting (a PIN said early is kept). */
  hearOverGreeting = false,
): Promise<voice.AgentSession> {
  let lastErr: unknown;
  for (const model of modelOrder()) {
    const llm = new openai.realtime.RealtimeModel({
      model,
      voice: 'marin',
      turnDetection: PHONE_TURN_DETECTION,
      inputAudioNoiseReduction: PHONE_NOISE_REDUCTION,
      inputAudioTranscription: transcription,
    });
    // Their speech never cuts a line by itself, and a line never waits for the room to go quiet: the
    // Conductor already waits for their turn to end, and wire() decides when a line is cut off.
    (llm.capabilities as { supportsOverlappingSpeech?: boolean }).supportsOverlappingSpeech = true;
    const session = new voice.AgentSession({
      llm,
      turnHandling: {
        turnDetection: 'realtime_llm',
        // The greeting and the goodbye are never cut off (see speak()).
        interruption: { enabled: true, discardAudioIfUninterruptible: !hearOverGreeting },
        preemptiveGeneration: { enabled: false },
      },
    });
    try {
      // No tools at all: the model cannot decide, approve or hang up.
      await session.start({
        agent: new voice.Agent({ instructions: LISTENER_INSTRUCTIONS, tools: [] }),
        room: ctx.room,
        outputOptions: { queueSizeMs: OUTPUT_QUEUE_MS },
      });
      log('listening session started with', model);
      return session;
    } catch (err) {
      lastErr = err;
      log(`model ${model} failed to start: ${(err as Error).message}`);
      await session.close().catch(() => undefined);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('no realtime model could start');
}

export default defineAgent({
  // Each job process starts before its call: synthesize the inbound greeting, the PIN lines and the
  // fillers now (not awaited), so an inbound call opens and answers the PIN from memory.
  prewarm: () => {
    log(`${bakedClips()} baked clips loaded`);
    void warm([...INBOUND_FIXED_LINES.slice(0, 6), ...INBOUND_FIRST_FILLERS, ...FILLERS.map((f) => f.text), ...INBOUND_SECOND_FILLERS], 2);
  },
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    const meta = ctx.job.metadata ? (JSON.parse(ctx.job.metadata) as { callId?: string }) : {};
    const server = createServerClient();
    const room = ctx.room.name ?? '';
    log(`joined ${room} (${meta.callId ? `outbound ${meta.callId}` : 'inbound'})`);
    try {
      if (meta.callId) await runOutbound(ctx, server, meta.callId, room);
      else await runInbound(ctx, server, room);
    } catch (err) {
      log('call failed:', (err as Error).message);
      if (meta.callId) await server.event(meta.callId, { type: 'failed' }).catch(() => undefined);
      await roomClient().deleteRoom(room).catch(() => undefined);
    }
  },
});

/**
 * Warm the lines we know ahead of time so they play instantly, a few at a time (a burst of TTS
 * requests gets throttled and would slow the live lines). Failures only cost latency.
 */
async function warm(lines: string[], parallel = 3): Promise<void> {
  const queue = [...new Set(lines)];
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      for (let l = queue.shift(); l !== undefined; l = queue.shift()) await prewarm(l).catch(() => undefined);
    }),
  );
}

/**
 * Pass a line's frames through, with timing marks for the test harness. The session reads a queued
 * line's first frame early (while the line before it still plays); after the line starts playing
 * (`started()`), a wait between frames longer than OUTPUT_QUEUE_MS would be a gap in the audio.
 */
function markFirstFrame(src: LineAudio, kind: LineKind, text: string, started: () => number): ReadableStream<AudioFrame> {
  const reader = src.getReader();
  let first = true;
  let lastPull = 0;
  let maxGap = 0;
  return new ReadableStream<AudioFrame>({
    async pull(controller) {
      const r = await reader.read();
      const now = Date.now();
      if (r.done) {
        // sound= again at the end: a split line only knows its full length once every part is in.
        mark('line_frames', `${kind} maxPullGap=${maxGap}${maxGap > OUTPUT_QUEUE_MS ? ' UNDERRUN' : ''} sound=${src.soundMs}`);
        return controller.close();
      }
      const playing = started();
      if (lastPull && playing && lastPull >= playing) maxGap = Math.max(maxGap, now - lastPull);
      lastPull = now;
      if (first) {
        first = false;
        mark('first_frame', `${kind} play=${src.playMs} sound=${src.soundMs} | ${text}`);
      }
      controller.enqueue(r.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * Wire a session to a Conductor: transcripts in, exact lines out, the once-only "ended" event and the
 * hang-up. Any reply the model starts on its own (there should be none) is cut off at once.
 */
function wire(
  ctx: JobContext,
  server: VoiceServerClient,
  callId: string,
  room: string,
  otherSpeaker: Speaker,
  session: voice.AgentSession,
  make: (port: CallPort) => Conductor,
) {
  let ended = false;
  let ours = false;
  const post = (speaker: Speaker, text: string) => {
    if (!text.trim()) return;
    void server.event(callId, { type: 'transcript', speaker, text: text.trim() }).catch((e) => log('transcript post failed', e.message));
  };
  const finish = async (reason: string) => {
    if (ended) return;
    ended = true;
    conductor.stop();
    log('call ended:', reason);
    await server.event(callId, { type: 'ended' }).catch((e) => log('ended post failed', e.message));
  };
  /** The line playing now (or queued last), so wire() can cut it off on a real barge-in. */
  type Line = { handle: voice.SpeechHandle; kind: LineKind; text: string; startedAt: number; endedAt: number; info: string };
  let current: Line | undefined;
  /**
   * Lines handed to the session that have not started playing yet, in order. The audio output says
   * when each one actually starts (its first frame reaches the speaker queue), which is when a line
   * can be cut and from which how much of it played is counted.
   */
  const waitingToPlay: Line[] = [];
  /** The line of ours (not a filler) that last started playing (a repeat of their words after "say it again" is real). */
  const realLine = { at: 0, text: '' };
  const startedLine = (l: Line | undefined, at: number) => {
    if (!l || l.startedAt) return;
    l.startedAt = at;
    if (l.kind !== 'filler') Object.assign(realLine, { at, text: l.text });
    mark('line_start', l.info);
  };
  const audioOut = session.output.audio;
  if (audioOut) audioOut.on('playbackStarted', (ev: { createdAt: number }) => startedLine(waitingToPlay.shift(), ev.createdAt || Date.now()));
  else log('no audio output to watch; a line counts as started when its first frame is read');
  const cuttable = () => !!current && !current.endedAt && current.startedAt > 0 && current.kind !== 'greeting' && current.kind !== 'goodbye' && !current.handle.interrupted;
  const cut = (why: string) => {
    if (!cuttable()) return;
    log(`cut off our line (${why}): "${current!.text}"`);
    current!.endedAt = Date.now();
    try {
      current!.handle.interrupt();
    } catch {
      /* already done */
    }
  };
  async function schedule(text: string, kind: LineKind, fromMs = 0): Promise<SpokenLine | undefined> {
    if (ended) return undefined;
    const allowInterruptions = kind !== 'greeting' && kind !== 'goodbye';
    let audio: ReadableStream<AudioFrame> | undefined;
    const t0 = Date.now();
    const line: Line = { handle: undefined as unknown as voice.SpeechHandle, kind, text, startedAt: 0, endedAt: 0, info: `${kind} play=0 sound=0 | ${text}` };
    try {
      const a = await audioFor(text, fromMs);
      line.info = `${kind} play=${a.playMs} sound=${a.soundMs} | ${fromMs ? `${text} (from ${fromMs} ms)` : text}`;
      audio = markFirstFrame(a, kind, text, () => {
        // Without playback events, the first frame read is the best guess of the start.
        if (!audioOut && !line.startedAt) startedLine(line, Date.now());
        return line.startedAt;
      });
      if (kind !== 'filler') log(`audio ready in ${Date.now() - t0} ms (${lastTtsInfo})`);
    } catch (err) {
      log(`TTS failed, the realtime voice reads the line instead: ${(err as Error).message}`);
    }
    // Never start a line over them (the framework used to wait for this; a line now only waits for us):
    // while they are still talking, hold it a moment (capped, so a noisy room never stalls the call).
    if (allowInterruptions && session.userState === 'speaking') {
      const t1 = Date.now();
      while (session.userState === 'speaking' && Date.now() - t1 < WAIT_FOR_QUIET_MS && !ended) await new Promise((r) => setTimeout(r, 50));
      log(`waited ${Date.now() - t1} ms for them to finish before speaking`);
    }
    if (ended) return undefined;
    // Posted as it starts, so the transcript keeps the order of the call (fillers and resumed rests are not posted).
    if (kind !== 'filler' && !fromMs) post('pacepay', text);
    ours = true;
    let handle: voice.SpeechHandle;
    try {
      handle = audio
        ? session.say(text, { audio, allowInterruptions, addToChatCtx: kind !== 'filler' && !fromMs })
        : session.generateReply({ instructions: EXACT(text), toolChoice: 'none', allowInterruptions });
    } finally {
      ours = false;
    }
    line.handle = handle;
    current = line;
    waitingToPlay.push(line);
    const playout = handle
      .waitForPlayout()
      .catch(() => undefined)
      .then(() => {
        line.endedAt ||= Date.now();
        // Never started (cut while queued): it must not take the next line's start.
        const k = waitingToPlay.indexOf(line);
        if (k >= 0) waitingToPlay.splice(k, 1);
        if (line.startedAt) mark('line_end', `${kind} ${line.endedAt - line.startedAt}${handle.interrupted ? ' cut' : ''}`);
      });
    return {
      playout,
      interrupted: () => handle.interrupted,
      playedMs: () => (line.startedAt ? (line.endedAt || Date.now()) - line.startedAt : 0),
    };
  }
  // Lines are scheduled one at a time, in the order asked, even when one waits on TTS longer.
  let queue: Promise<unknown> = Promise.resolve();
  const port: CallPort = {
    speak(text: string, kind: LineKind, opts?: { fromMs?: number }) {
      // A filler only makes sense right now: play it from memory or not at all, never queued.
      if (kind === 'filler') return isReady(text) ? schedule(text, kind) : Promise.resolve(undefined);
      const turn = queue.then(() => schedule(text, kind, opts?.fromMs ?? 0));
      queue = turn.catch(() => undefined);
      return turn;
    },
    userSpeaking: () => session.userState === 'speaking',
    agentSpeaking: () => session.agentState === 'speaking',
    hangUp: async (reason: string) => {
      await finish(reason);
      await roomClient().deleteRoom(room).catch((e) => log('deleteRoom failed', e.message));
    },
    prepare: (lines: string[]) => void warm(lines, 2),
    prime: (text: string) => startLine(text),
    sendDtmf: async (digits: string) => {
      if (ended) return false;
      // After whatever line is already queued, so tones never talk over our own words.
      await queue;
      await sendDtmf(ctx.room, digits);
      const n = digits.replace(/[^0-9*#]/g, '');
      // The transcript shows a menu choice ("pressed 1"); longer strings only by count.
      post('pacepay', n.length === 1 ? `(pressed ${n})` : `(pressed ${n.length} keys)`);
      return true;
    },
    log: (...a: unknown[]) => log(...a),
  };
  const conductor = make(port);

  session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
    if (ours) return;
    log(`blocked a reply PacePay did not ask for (${ev.source})`);
    try {
      ev.speechHandle.interrupt(true);
    } catch {
      /* already done */
    }
  });
  let bargeTimer: NodeJS.Timeout | undefined;
  session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
    // Only the start and end of their speech ("listening" -> "away" after a quiet spell is not a turn).
    if (ev.newState !== 'speaking' && ev.oldState !== 'speaking') return;
    clearTimeout(bargeTimer);
    if (ev.newState !== 'speaking') mark('vad_end');
    else if (cuttable()) {
      // Still talking BARGE_MS later, over our line: a real barge-in, stop and let them talk.
      bargeTimer = setTimeout(() => {
        if (session.userState === 'speaking') cut(`they kept talking ${BARGE_MS} ms`);
      }, BARGE_MS);
    }
    conductor.onUserState(ev.newState === 'speaking');
  });
  const dedupe = new TranscriptDeduper();
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
    if (!ev.isFinal) return;
    mark('transcript');
    // The same turn delivered twice (same item, or the same words again before we said anything): once only.
    if (ev.transcript.trim() && dedupe.isDuplicate(ev.transcript, (ev as { itemId?: string }).itemId, Date.now(), realLine)) {
      log('dropped a duplicate transcript of the same turn');
      conductor.onDuplicateTranscript();
      return;
    }
    if (isPromptLeak(ev.transcript)) {
      log('ignored a transcript that was the transcription prompt itself (noise)');
      if (!ended) conductor.onTranscript('');
      return;
    }
    post(otherSpeaker, ev.transcript);
    // Real words said over our line (a short barge-in like "wait, no"): stop it, their turn comes first.
    // "Mm-hm", "okay" and our own line coming back never cut it.
    const heard = ev.transcript.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (cuttable() && !isJunk(heard) && !BACKCHANNEL.test(heard) && !isEchoOf(heard, current!.text)) cut('they said something');
    if (!ended) conductor.onTranscript(ev.transcript);
  });
  session.on(voice.AgentSessionEventTypes.Error, (ev) => log('session error:', String((ev.error as Error)?.message ?? ev.error)));
  // The other side hanging up (or the room closing) ends the call.
  ctx.room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
    if (p.kind === ParticipantKind.SIP || p.identity === 'counterparty' || otherSpeaker === 'customer') void finish('the other side hung up');
  });
  ctx.room.on(RoomEvent.Disconnected, () => void finish('room closed'));
  return { conductor, port, post };
}

async function runOutbound(ctx: JobContext, server: VoiceServerClient, callId: string, room: string): Promise<void> {
  const brief = await server.brief(callId);
  const warming = warm([brief.greeting, ...FILLERS.map((f) => f.text)]);
  // Not awaited: the lines that may come later (the hold line after "yes" above all).
  void warming.then(() => {
    // The likely lines: the hold line first (it follows every "yes" to a read-back), then lines about
    // the asked-for day, then the rest.
    const likely = likelyLines(brief.personName);
    return warm([...likely.slice(0, 4), ...targetDayLines(brief.greeting), ...likely.slice(4), ...holdUpdates(brief.personName)], 2);
  });
  const session = await startSession(ctx);
  const w = wire(ctx, server, callId, room, 'counterparty', session, (port) => new OutboundConductor(port, server, callId, brief.personName));

  // The SIP participant joins the room only once the lender picks up.
  const counterparty = await ctx.waitForParticipant('counterparty');
  log('answered by', counterparty.identity);
  await server.event(callId, { type: 'answered' }).catch((e) => log('answered post failed', e.message));
  await Promise.race([warming, new Promise((r) => setTimeout(r, 2_500))]);
  await w.port.speak(brief.greeting, 'greeting');
  log(`say (greeting): "${brief.greeting}"`);
}

async function runInbound(ctx: JobContext, server: VoiceServerClient, room: string): Promise<void> {
  // The listening session starts at once, alongside the wait for the caller and /voice/inbound; the
  // fixed lines (greeting, PIN replies, fillers) are mostly synthesized already (prewarm above).
  const sessionP = startSession(ctx, INBOUND_TRANSCRIPTION, true);
  sessionP.catch(() => undefined);
  void warm([...INBOUND_FIXED_LINES, ...INBOUND_FIRST_FILLERS, ...FILLERS.map((f) => f.text), ...INBOUND_SECOND_FILLERS, INBOUND_IDLE_GOODBYE], 2);
  // Keypad PIN (SIP DTMF arrives as a data packet: RoomEvent.DtmfReceived). Digits typed before the
  // call is wired up are kept and handed over in order. A digit is never logged, only that one came.
  let onKey: ((digit: string) => void) | undefined;
  const early: string[] = [];
  ctx.room.on(RoomEvent.DtmfReceived, (code: number, digit: string) => {
    const d = keypadDigit(code, digit);
    if (!d) return;
    mark('keypad');
    if (onKey) onKey(d);
    else early.push(d);
  });
  const caller = await ctx.waitForParticipant();
  const joinedAt = Date.now();
  const phone = caller.attributes?.['sip.phoneNumber'] ?? '';
  log('inbound caller number present:', phone ? 'yes' : 'no');
  const [inbound, session] = await Promise.all([server.inbound({ room, callerPhone: phone }), sessionP]);
  const w = wire(ctx, server, inbound.callId, room, 'customer', session, (port) => new InboundConductor(port, server, inbound.callId));
  const conductor = w.conductor as InboundConductor;
  onKey = (d) => {
    // The transcript shows that a PIN was typed, never the digits.
    if (conductor.onKeypad(d)) w.post('customer', '(typed the PIN on the keypad)');
  };
  early.splice(0).forEach(onKey);
  // From memory when warm (synthesized while the job process waited); otherwise synthesized now.
  log(`greeting ${isReady(inbound.greeting) ? 'ready' : 'not ready, synthesizing'}`);
  // A beat after they connect before "Hi": the first ~half second of a fresh audio path gets
  // stretched while the far end's jitter buffer settles (measured: +40-50 ms inside the greeting).
  const settle = joinedAt + GREETING_SETTLE_MS - Date.now();
  if (settle > 0) await new Promise((r) => setTimeout(r, settle));
  await w.port.speak(inbound.greeting, 'greeting');
  log(`say (greeting): "${inbound.greeting}"`);
}

/** A keypad key from a SIP DTMF event: the digit if it came, else from its RFC 4733 code. */
export function keypadDigit(code: number, digit: string): string | undefined {
  if (/^[0-9*#]$/.test(digit ?? '')) return digit;
  if (code >= 0 && code <= 9) return String(code);
  if (code === 10) return '*';
  if (code === 11) return '#';
  return undefined;
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PACEPAY_VOICE_PORT) || undefined;
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME, ...(port ? { port } : {}) }));
}
