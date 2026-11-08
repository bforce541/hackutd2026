/**
 * LiveKit call dispatch (SPEC §7.1). Implemented by: voice.
 *
 * placeCall: agentDispatch.createDispatch(room, 'pacepay-voice', { metadata: JSON.stringify({ callId }) }),
 * then sip.createSipParticipant(LIVEKIT_SIP_OUTBOUND_TRUNK_ID, phone, room,
 *   { participantIdentity: 'counterparty', waitUntilAnswered: true, playDialtone: true }).
 * A SIP failure throws SipCallError; place_call turns it into a CALL_FAILED event.
 * hangUp: delete the room through RoomServiceClient.
 */

import { AgentDispatchClient, RoomServiceClient, SipClient } from 'livekit-server-sdk';
import { requireEnv } from '../env';

export const VOICE_AGENT_NAME = 'pacepay-voice';
export const ROOM_PREFIX = 'photon-';
export const roomForCall = (callId: string): string => `${ROOM_PREFIX}${callId}`;

/** The metadata the server attaches to an outbound dispatch; the worker parses it. */
export interface DispatchMetadata {
  callId: string;
}

export interface PlaceCallArgs {
  callId: string;
  room: string;
  phone: string; // E.164, LENDER_PHONE for the demo
}

export class SipCallError extends Error {
  readonly code = 'sip_call_failed';
  constructor(
    message: string,
    readonly sipStatus?: string,
  ) {
    super(message);
  }
}

export interface CallDispatcher {
  placeCall(args: PlaceCallArgs): Promise<void>;
  hangUp(room: string): Promise<void>;
}

/** How long we wait for the lender to pick up before calling it a failed call. */
export const ANSWER_TIMEOUT_MS = 45_000;

function clients() {
  const url = requireEnv('LIVEKIT_URL').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  const key = requireEnv('LIVEKIT_API_KEY');
  const secret = requireEnv('LIVEKIT_API_SECRET');
  return {
    dispatch: new AgentDispatchClient(url, key, secret),
    sip: new SipClient(url, key, secret),
    rooms: new RoomServiceClient(url, key, secret),
  };
}

export async function placeCall(args: PlaceCallArgs): Promise<void> {
  const trunk = requireEnv('LIVEKIT_SIP_OUTBOUND_TRUNK_ID');
  const { dispatch, sip, rooms } = clients();
  const metadata: DispatchMetadata = { callId: args.callId };
  let timer: NodeJS.Timeout | undefined;
  try {
    await dispatch.createDispatch(args.room, VOICE_AGENT_NAME, { metadata: JSON.stringify(metadata) });
    await Promise.race([
      sip.createSipParticipant(trunk, args.phone, args.room, {
        participantIdentity: 'counterparty',
        waitUntilAnswered: true,
        playDialtone: true,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${ANSWER_TIMEOUT_MS / 1000}s`)), ANSWER_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    // Tidy the room so the worker does not sit in an empty call.
    await rooms.deleteRoom(args.room).catch(() => undefined);
    if (err instanceof SipCallError) throw err;
    const e = err as { message?: string; metadata?: Record<string, string> };
    const sipStatus = e.metadata?.sip_status_code ?? e.metadata?.sip_status;
    throw new SipCallError(e.message ?? 'SIP call failed', sipStatus);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function hangUp(room: string): Promise<void> {
  await clients().rooms.deleteRoom(room);
}

export const dispatcher: CallDispatcher = { placeCall, hangUp };
