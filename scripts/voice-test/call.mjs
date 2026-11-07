import { AgentDispatchClient, SipClient, RoomServiceClient } from 'livekit-server-sdk';
const e=process.env; const h=e.LIVEKIT_URL.replace('wss','https');
const room=process.argv[2]||('photon-test-'+Date.now()); const to=process.argv[3]||e.LENDER_PHONE;
const d=new AgentDispatchClient(h,e.LIVEKIT_API_KEY,e.LIVEKIT_API_SECRET), s=new SipClient(h,e.LIVEKIT_API_KEY,e.LIVEKIT_API_SECRET), rs=new RoomServiceClient(h,e.LIVEKIT_API_KEY,e.LIVEKIT_API_SECRET);
console.log('room',room,'to',to===e.LENDER_PHONE?'LENDER_PHONE':'PHOTON_VOICE_NUMBER');
const t0=Date.now();
try{
  console.log('dispatch', (await d.createDispatch(room,'pacepay-voice',{metadata:JSON.stringify({callId:room})})).id);
  const p=await Promise.race([s.createSipParticipant(e.LIVEKIT_SIP_OUTBOUND_TRUNK_ID,to,room,{participantIdentity:'counterparty',waitUntilAnswered:true,playDialtone:true}),new Promise((_,j)=>setTimeout(()=>j(new Error('client timeout 45s')),45000))]);
  console.log('ANSWERED', p.participantIdentity, p.sipCallId, ((Date.now()-t0)/1000)+'s');
  await new Promise(r=>setTimeout(r,20000));
}catch(err){ console.log('FAIL', err.name, err.message, 'sipStatus', err.metadata?.['sip_status'], err.metadata?.['sip_status_code'], err.code, ((Date.now()-t0)/1000)+'s'); }
try{console.log('rooms before cleanup',(await rs.listRooms()).map(r=>r.name)); await rs.deleteRoom(room);}catch(x){console.log('cleanup',x.message)}
console.log('total', ((Date.now()-t0)/1000)+'s');
