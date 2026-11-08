/**
 * SPEC §6: the one messaging interface. The rest of the server only uses this.
 * Contract owned by server-core; the Photon adapter (photon.ts) is implemented by: photon.
 */
export interface MessagingPort {
  start(onInbound: (m: InboundMessage) => Promise<void>): Promise<void>;
  sendText(text: string): Promise<{ id: string }>;
  sendImage(png: Buffer, name: string): Promise<{ id: string }>;
  fetchImage(ref: string): Promise<Buffer>; // incoming bill photos
}

export interface InboundMessage {
  id: string;
  from: string;
  text?: string;
  imageRef?: string;
  /** e.g. 'image/jpeg'; index.ts assumes JPEG when the provider does not say. */
  imageContentType?: string;
  at: string;
}
