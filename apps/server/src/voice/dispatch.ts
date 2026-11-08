/**
 * LiveKit call dispatch (SPEC §7.1). Implemented by: voice.
 *
 * placeCall: agentDispatch.createDispatch(room, 'pacepay-voice', { metadata: JSON.stringify({ callId }) }),
 * then sip.createSipParticipant(LIVEKIT_SIP_OUTBOUND_TRUNK_ID, phone, room,
 *   { participantIdentity: 'counterparty', waitUntilAnswered: true, playDialtone: true }).
 * A SIP failure throws SipCallError; place_call turns it into a CALL_FAILED event.
 * hangUp: delete the room through RoomServiceClient.
 */

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

export async function placeCall(_args: PlaceCallArgs): Promise<void> {
  throw new SipCallError('voice.placeCall: not implemented yet');
}

export async function hangUp(_room: string): Promise<void> {
  throw new Error('voice.hangUp: not implemented yet');
}

export const dispatcher: CallDispatcher = { placeCall, hangUp };
