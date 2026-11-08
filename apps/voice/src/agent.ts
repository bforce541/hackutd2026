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
import { cli, defineAgent, ServerOptions, type JobContext } from '@livekit/agents';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const AGENT_NAME = 'pacepay-voice';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    const meta = ctx.job.metadata ? (JSON.parse(ctx.job.metadata) as { callId?: string }) : {};
    console.log(`[voice] joined ${ctx.room.name} (${meta.callId ? `outbound ${meta.callId}` : 'inbound'}); session not implemented yet`);
  },
});

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
