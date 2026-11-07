import { defineAgent, cli, WorkerOptions, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { RoomServiceClient } from 'livekit-server-sdk';
import { fileURLToPath } from 'node:url';
const e=process.env; const MODEL=e.OPENAI_REALTIME_MODEL_TEST||'gpt-realtime-2.1';
const log=(...a)=>console.log(new Date().toISOString(),'[worker]',...a);
export default defineAgent({
  entry: async (ctx) => {
    log('job received, room', ctx.room.name);
    await ctx.connect();
    log('connected; participants', [...ctx.room.remoteParticipants.values()].map(p=>p.identity+'/'+p.kind));
    const session = new voice.AgentSession({ llm: new openai.realtime.RealtimeModel({ model: MODEL, voice: 'marin' }) });
    session.on('conversation_item_added', ev=>log('item', ev.item.role, JSON.stringify(ev.item.textContent)));
    session.on('agent_state_changed', ev=>log('agent_state', ev.newState));
    session.on('speech_created', ev=>log('speech_created', ev.source));
    session.on('error', ev=>log('ERROR', String(ev.error?.message||ev.error)));
    await session.start({ agent: new voice.Agent({ instructions: 'You are a test caller. Say exactly what you are told, nothing else.' }), room: ctx.room });
    const hs = session.generateReply({ instructions: 'Say exactly: "Hi, this is a PacePay test call. The voice line works. Goodbye."' });
    await hs.waitForPlayout?.();
    log('speech playout done');
    await new Promise(r=>setTimeout(r,1000));
    const rs=new RoomServiceClient(e.LIVEKIT_URL.replace('wss','https'),e.LIVEKIT_API_KEY,e.LIVEKIT_API_SECRET);
    await rs.deleteRoom(ctx.room.name); log('room deleted');
  },
});
cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url), agentName: 'pacepay-voice' }));
