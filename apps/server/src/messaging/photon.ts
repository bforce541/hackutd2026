/**
 * The Photon 2.0 adapter for MessagingPort (SPEC §6). Implemented by: photon.
 *
 * - Client: `@photon-ai/api` with PHOTON_API_KEY against https://api.photon.codes/v1; always send a User-Agent.
 * - Receive: poll listMessages every 2 s (direction received, order asc, follow nextPageToken).
 *   Accept only CUSTOMER_PHONE (normalize to E.164). Restart the loop 2 s after a throw and log a warn.
 * - Send text into PHOTON_CUSTOMER_SPACE_ID as PHOTON_AGENT_SENDER_ID with an idempotency key.
 * - Send image: upload via attachments (multipart/related, two parts), then send { type: 'attachment' }.
 * - fetchImage: GET /v1/projects/{id}/attachments/{attachmentId}/content.
 */
import type { MessagingPort } from './port';

export interface PhotonOptions {
  apiKey: string;
  projectId: string;
  customerPhone: string;
  spaceId: string;
  senderId: string;
  pollMs?: number;
  /** Called on loop errors so they reach the activity feed as warn events. */
  onWarn?: (title: string, detail?: unknown) => void;
}

export function createPhotonMessaging(_opts: PhotonOptions): MessagingPort {
  const notYet = (what: string) => Promise.reject(new Error(`photon.${what}: not implemented yet`));
  return {
    start: () => notYet('start'),
    sendText: () => notYet('sendText'),
    sendImage: () => notYet('sendImage'),
    fetchImage: () => notYet('fetchImage'),
  };
}
