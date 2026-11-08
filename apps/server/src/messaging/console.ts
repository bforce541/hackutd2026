/**
 * A MessagingPort that prints to the server log instead of texting. Used when Photon is not
 * configured (PACEPAY_MESSAGING=console), in tests and in demo:e2e. Implemented by: server-core.
 * Inbound messages arrive through POST /api/demo/customer-says and POST /api/thread instead.
 */
import type { InboundMessage, MessagingPort } from './port';
import { newId } from '../ids';

export function createConsoleMessaging(log: (line: string) => void = (l) => console.log(l)): MessagingPort {
  return {
    async start(_onInbound: (m: InboundMessage) => Promise<void>) {
      log('[messaging] console mode: texts are printed, not sent');
    },
    async sendText(text) {
      log(`[messaging] -> Yoshua: ${text.replace(/\n/g, ' / ')}`);
      return { id: newId('msg') };
    },
    async sendImage(png, name) {
      log(`[messaging] -> Yoshua: image ${name} (${png.length} bytes)`);
      return { id: newId('msg') };
    },
    async fetchImage(ref) {
      throw new Error(`console messaging cannot fetch image ${ref}`);
    },
  };
}
