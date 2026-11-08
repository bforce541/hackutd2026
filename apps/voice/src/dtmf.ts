/**
 * DTMF over the LiveKit SIP call (RFC 4733 / RFC 2833 telephone-events).
 *
 * Uses LocalParticipant.publishDtmf(code, digit) from @livekit/rtc-node; LiveKit SIP bridges it
 * to the PSTN leg as in-band telephone events (for IVR menus: "press 1 for payments").
 *
 * HOW conductor.ts SHOULD CALL IT when the server's decide result carries { dtmf: string }:
 *
 *   import { sendDtmf } from './dtmf';
 *   ...
 *   if (result.dtmf) {
 *     await sendDtmf(ctx.room, result.dtmf);   // `ctx.room` is the rtc-node Room (agent.ts)
 *     // then keep listening (next: 'listen'); do not speak over the menu
 *   }
 *
 * Digits allowed: 0-9 * #. Anything else (including ',' pause or 'w') is ignored, except ','
 * which inserts a 500 ms pause. Digits go out ~250 ms apart (a 100 ms tone plus a gap, so IVRs
 * do not merge them). Throws if the room has no local participant (not connected) or if
 * the string has no sendable digit. Never logs digits beyond count (PINs may be sent).
 */
import type { Room } from '@livekit/rtc-node';

/** RFC 4733 event codes: 0-9 -> 0-9, * -> 10, # -> 11. */
export function dtmfCode(digit: string): number | undefined {
  if (digit.length !== 1) return undefined;
  if (digit >= '0' && digit <= '9') return digit.charCodeAt(0) - 48;
  if (digit === '*') return 10;
  if (digit === '#') return 11;
  return undefined;
}

export const DTMF_GAP_MS = 250;
export const DTMF_PAUSE_MS = 500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function sendDtmf(room: Pick<Room, 'localParticipant'>, digits: string): Promise<void> {
  const lp = room.localParticipant;
  if (!lp) throw new Error('sendDtmf: room has no local participant (not connected)');
  const seq = [...digits.replace(/\s+/g, '')].filter((d) => d === ',' || dtmfCode(d) !== undefined);
  if (!seq.some((d) => d !== ',')) throw new Error('sendDtmf: no sendable digits (allowed 0-9 * # ,)');
  for (const d of seq) {
    if (d === ',') {
      await sleep(DTMF_PAUSE_MS);
      continue;
    }
    await lp.publishDtmf(dtmfCode(d)!, d);
    await sleep(DTMF_GAP_MS);
  }
}
