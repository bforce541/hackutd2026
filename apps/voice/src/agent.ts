/**
 * The LiveKit Agents worker (SPEC §7.2). Implemented by: voice.
 * Run: `pnpm --filter @pacepay/voice dev` (through dotenvx; needs LIVEKIT_* and OPENAI_API_KEY).
 *
 * Outbound: the job's metadata is { callId } (DispatchMetadata on the server); fetch the brief,
 * start a realtime session (OPENAI_REALTIME_MODEL, voice 'marin', falling back to gpt-realtime-2,
 * then gpt-realtime), open with the brief's greeting, post every transcript line to /events.
 * Inbound: no metadata; read the caller's number from the SIP participant attributes
 * (sip.phoneNumber), POST /api/voice/inbound, then the PIN flow (prompts/voice-inbound.md).
 */
import { cli, defineAgent, ServerOptions, voice, type JobContext } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { RoomServiceClient } from 'livekit-server-sdk';
import { ParticipantKind, RoomEvent, type RemoteParticipant } from '@livekit/rtc-node';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { Speaker } from '@pacepay/shared';
import { createServerClient, type VoiceServerClient } from './server';
import { inboundTools, outboundTools, type VoiceToolHooks } from './tools';

export const AGENT_NAME = 'pacepay-voice';
const MODEL_FALLBACKS = ['gpt-realtime-2.1', 'gpt-realtime-2', 'gpt-realtime'];
const here = dirname(fileURLToPath(import.meta.url));
const log = (...a: unknown[]) => console.log(new Date().toISOString(), '[voice]', ...a);

function prompt(name: 'voice' | 'voice-inbound', vars: Record<string, string>): string {
  let text = readFileSync(join(here, 'prompts', `${name}.md`), 'utf8').replace(/<!--[\s\S]*?-->\s*/g, '');
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v);
  return text.trim();
}

const STYLE =
  '\nSpeak at a natural pace. Say any returned "say" text word for word. ' +
  'While a tool runs you may say only "One moment." and nothing else.';

/**
 * Phone-line turn-taking. Server VAD is less jumpy than the default semantic VAD on 8 kHz line noise
 * and echo: a 0.7 threshold, 300 ms of audio kept before speech, and 700 ms of silence to end a turn.
 * The server must not cancel our reply on a noise burst either, so interrupt_response is false.
 */
const PHONE_TURN_DETECTION = {
  type: 'server_vad' as const,
  threshold: 0.7,
  prefix_padding_ms: 300,
  silence_duration_ms: 700,
  create_response: true,
  interrupt_response: false,
};
const PHONE_NOISE_REDUCTION = { type: 'near_field' as const };
const PHONE_TRANSCRIPTION = {
  model: 'gpt-4o-mini-transcribe',
  language: 'en',
  prompt: 'A short phone call in English between an assistant and a loan servicer about a payment date, a fee and a reference number.',
};

function modelOrder(): string[] {
  const preferred = process.env.OPENAI_REALTIME_MODEL;
  return [...new Set([preferred, ...MODEL_FALLBACKS].filter((m): m is string => !!m))];
}

function roomClient(): RoomServiceClient {
  const e = process.env;
  return new RoomServiceClient(e.LIVEKIT_URL!.replace(/^wss:/, 'https:'), e.LIVEKIT_API_KEY!, e.LIVEKIT_API_SECRET!);
}

/** Start the realtime session, trying each model in turn if one is not available. */
async function startSession(ctx: JobContext, agent: voice.Agent): Promise<voice.AgentSession> {
  let lastErr: unknown;
  for (const model of modelOrder()) {
    const session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        model,
        voice: 'marin',
        turnDetection: PHONE_TURN_DETECTION,
        inputAudioNoiseReduction: PHONE_NOISE_REDUCTION,
        inputAudioTranscription: PHONE_TRANSCRIPTION,
      }),
      turnHandling: {
        // The realtime model's own server VAD decides turns; no separate TurnDetector (it was ignored and warned).
        turnDetection: 'realtime_llm',
        // Our lines are one or two short sentences and a noise burst must not cut them off. While PacePay
        // speaks, input audio is dropped, which also keeps echo out of the model. The lender waits their turn.
        interruption: { enabled: false },
      },
    });
    try {
      await session.start({ agent, room: ctx.room });
      log('realtime session started with', model);
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

interface Wired {
  session: voice.AgentSession;
  hooks: VoiceToolHooks;
  finish(reason: string): Promise<void>;
}

/** Transcript posting, hang-up and the once-only "ended" event, shared by both directions. */
function wire(ctx: JobContext, server: VoiceServerClient, callId: string, room: string, otherSpeaker: Speaker) {
  let session: voice.AgentSession | undefined;
  let lastSpeech: voice.SpeechHandle | undefined;
  let ended = false;
  const post = (speaker: Speaker, text: string) => {
    if (!text.trim()) return;
    void server.event(callId, { type: 'transcript', speaker, text: text.trim() }).catch((e) => log('transcript post failed', e.message));
  };
  const finish = async (reason: string) => {
    if (ended) return;
    ended = true;
    log('call ended:', reason);
    try {
      await lastSpeech?.waitForPlayout();
    } catch {
      /* nothing playing */
    }
    await server.event(callId, { type: 'ended' }).catch((e) => log('ended post failed', e.message));
  };
  const hooks: VoiceToolHooks = {
    // A realtime model has no TTS, so session.say() would throw; have the model speak the line instead.
    // The line is posted to the transcript by the ConversationItemAdded listener, not here.
    say: async (text) => {
      session?.generateReply({ instructions: `Say exactly this and nothing else, then stop and listen: "${text}"` });
    },
    hangUp: async () => {
      await roomClient().deleteRoom(room).catch((e) => log('deleteRoom failed', e.message));
    },
    end: finish,
  };
  const attach = (s: voice.AgentSession) => {
    session = s;
    s.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
      lastSpeech = ev.speechHandle;
    });
    s.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.isFinal) post(otherSpeaker, ev.transcript);
    });
    s.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item as { type?: string; role?: string; textContent?: string };
      if (item.type === 'message' && item.role === 'assistant' && item.textContent) post('pacepay', item.textContent);
    });
    s.on(voice.AgentSessionEventTypes.Error, (ev) => log('session error:', String((ev.error as Error)?.message ?? ev.error)));
  };
  // The other side hanging up (or the room closing) ends the call.
  ctx.room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
    if (p.kind === ParticipantKind.SIP) void finish('caller hung up');
  });
  ctx.room.on(RoomEvent.Disconnected, () => void finish('room closed'));
  return { attach, hooks, finish, post };
}

async function runOutbound(ctx: JobContext, server: VoiceServerClient, callId: string, room: string): Promise<void> {
  const brief = await server.brief(callId);
  const instructions =
    prompt('voice', {
      counterparty_name: brief.counterpartyName ?? 'the lender',
      person_name: brief.personName,
      greeting: brief.greeting,
    }) + STYLE;
  const w = wire(ctx, server, callId, room, 'counterparty');
  const agent = new voice.Agent({ instructions, tools: Object.values(outboundTools(server, callId, w.hooks)) });
  const session = await startSession(ctx, agent);
  w.attach(session);

  // The SIP participant joins the room only once the lender picks up.
  const counterparty = await ctx.waitForParticipant('counterparty');
  log('answered by', counterparty.identity);
  await server.event(callId, { type: 'answered' }).catch((e) => log('answered post failed', e.message));
  session.generateReply({ instructions: `Say exactly this and nothing else, then stop and listen: "${brief.greeting}"` });
}

async function runInbound(ctx: JobContext, server: VoiceServerClient, room: string): Promise<void> {
  const caller = await ctx.waitForParticipant();
  const phone = caller.attributes?.['sip.phoneNumber'] ?? '';
  log('inbound caller number present:', phone ? 'yes' : 'no');
  const inbound = await server.inbound({ room, callerPhone: phone });
  const instructions =
    prompt('voice-inbound', { person_name: 'Yoshua', greeting: inbound.greeting }) + STYLE;
  const w = wire(ctx, server, inbound.callId, room, 'customer');
  const agent = new voice.Agent({ instructions, tools: Object.values(inboundTools(server, inbound.callId, w.hooks)) });
  const session = await startSession(ctx, agent);
  w.attach(session);
  session.generateReply({ instructions: `Say exactly this and nothing else, then stop and listen: "${inbound.greeting}"` });
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
