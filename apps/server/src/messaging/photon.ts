/**
 * The Photon 2.0 adapter for MessagingPort (SPEC §6). Implemented by: photon.
 *
 * Raw REST against https://api.photon.codes/v1 (the verified recipe; no SDK needed):
 * - Every request carries a User-Agent (Photon's bot filter rejects default clients) and the bearer key.
 * - Receive: poll listMessages (direction received, order asc, createdSince, follow nextPageToken)
 *   every 2 s. Only CUSTOMER_PHONE (normalized to E.164) is accepted. A throw restarts the loop
 *   2 s later and reports a warn through onWarn.
 * - Send text into the customer space as the agent sender, with an Idempotency-Key.
 * - Send image: POST /attachments as multipart/related (JSON part, then bytes), then send
 *   { type: 'attachment', attachmentId } with NO metadata.
 * - fetchImage: GET /attachments/{id}/content.
 * - Read receipts: each of his messages is marked read (POST /messages/{id}/read) as soon as PacePay picks it up.
 * - Typing bubble (POST /spaces/{id}/typing) from then until PacePay's next send (25 s cap).
 */
import { randomUUID } from 'node:crypto';
import type { InboundMessage, MessagingPort } from './port';

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

const BASE = 'https://api.photon.codes/v1';
const USER_AGENT = 'pacepay/0.1';

/** "(214) 555-1234" / "2145551234" / "+12145551234" -> "+12145551234" (US default for 10 digits). */
export function toE164(raw: string | undefined | null): string {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (raw.trim().startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

interface PhotonMessage {
  id: string;
  content?: { type?: string; text?: string; attachmentId?: string };
  createdAt?: string;
  space?: { id?: string };
  sentBy?: { handle?: string; kind?: string } | string;
}

interface Page {
  items?: PhotonMessage[];
  nextPageToken?: string | null;
}

export function createPhotonMessaging(opts: PhotonOptions): MessagingPort {
  const project = `${BASE}/projects/${opts.projectId}`;
  const pollMs = opts.pollMs ?? 2000;
  const customer = toE164(opts.customerPhone);
  const warn = opts.onWarn ?? ((t, d) => console.warn(`[photon] ${t}`, d ?? ''));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${opts.apiKey}`, 'user-agent': USER_AGENT, ...extra };
  }

  async function fail(what: string, res: Response): Promise<never> {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Photon ${what} failed: ${res.status} ${body}`);
  }

  async function listPage(createdSince: string, pageToken?: string): Promise<Page> {
    const q = new URLSearchParams({ direction: 'received', order: 'asc', pageSize: '100', platform: 'imessage', createdSince });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await fetch(`${project}/messages?${q}`, { headers: headers() });
    if (!res.ok) await fail('listMessages', res);
    return (await res.json()) as Page;
  }

  async function postMessage(content: Record<string, unknown>): Promise<{ id: string }> {
    stopTyping();
    const res = await fetch(`${project}/messages`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json', 'idempotency-key': `pacepay:${randomUUID()}` }),
      body: JSON.stringify({ spaceId: opts.spaceId, senderId: opts.senderId, content }),
    });
    if (!res.ok) await fail('sendMessage', res);
    const j = (await res.json()) as { id?: string };
    return { id: j.id ?? '' };
  }

  /** Read receipt: marks his message read (fire and forget; a failure only logs once a minute). */
  let lastReadWarn = 0;
  function markRead(messageId: string): void {
    void fetch(`${project}/messages/${encodeURIComponent(messageId)}/read`, {
      method: 'POST',
      headers: headers({ 'idempotency-key': `pacepay-read:${messageId}` }),
    })
      .then(async (res) => {
        if (!res.ok && Date.now() - lastReadWarn > 60_000) {
          lastReadWarn = Date.now();
          warn(`Photon mark-read failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
        }
      })
      .catch(() => undefined);
  }

  /**
   * Typing bubble: on as soon as his message is picked up, refreshed every 5 s, off when PacePay sends
   * anything or after 25 s (some messages get no reply). Fire and forget; never blocks a send.
   */
  const TYPING_REFRESH_MS = 5_000;
  const TYPING_MAX_MS = 25_000;
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  let typingUntil = 0;
  function postTyping(on: boolean): void {
    if (!opts.spaceId || !opts.senderId) return;
    void fetch(`${BASE}/projects/${opts.projectId}/spaces/${encodeURIComponent(opts.spaceId)}/typing`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json', 'idempotency-key': `pacepay-typing:${randomUUID()}` }),
      body: JSON.stringify({ senderId: opts.senderId, typing: on }),
    }).catch(() => undefined);
  }
  function startTyping(): void {
    typingUntil = Date.now() + TYPING_MAX_MS;
    postTyping(true);
    if (typingTimer) return;
    typingTimer = setInterval(() => {
      if (Date.now() >= typingUntil) return stopTyping();
      postTyping(true);
    }, TYPING_REFRESH_MS);
    typingTimer.unref?.();
  }
  function stopTyping(): void {
    if (!typingTimer) return;
    clearInterval(typingTimer);
    typingTimer = undefined;
    postTyping(false);
  }

  function toInbound(m: PhotonMessage): InboundMessage | null {
    const sender = typeof m.sentBy === 'object' && m.sentBy ? m.sentBy : undefined;
    const from = toE164(sender?.handle);
    if (!customer || from !== customer) return null;
    const c = m.content ?? {};
    if (c.type === 'text' && c.text) return { id: m.id, from, text: c.text, at: m.createdAt ?? new Date().toISOString() };
    if (c.type === 'attachment' && c.attachmentId) return { id: m.id, from, imageRef: c.attachmentId, at: m.createdAt ?? new Date().toISOString() };
    return null; // other content kinds (polls, etc.) are ignored
  }

  async function pollForever(onInbound: (m: InboundMessage) => Promise<void>): Promise<void> {
    // Start from now: older messages were handled (or deliberately ignored) in earlier runs.
    let since = new Date().toISOString();
    const seen = new Set<string>();
    for (;;) {
      try {
        let token: string | undefined;
        do {
          const page = await listPage(since, token);
          for (const m of page.items ?? []) {
            if (seen.has(m.id)) continue;
            seen.add(m.id);
            if (m.createdAt && m.createdAt > since) since = m.createdAt;
            const inbound = toInbound(m);
            if (inbound) {
              markRead(m.id);
              startTyping();
              await onInbound(inbound);
            }
          }
          token = page.nextPageToken ?? undefined;
        } while (token);
        if (seen.size > 2000) seen.clear(); // createdSince keeps old ones out; the set only covers the boundary
      } catch (err) {
        warn(`Photon receive loop failed, restarting in 2 s: ${(err as Error).message}`, { error: String(err) });
        await sleep(2000);
        continue;
      }
      await sleep(pollMs);
    }
  }

  return {
    async start(onInbound) {
      void pollForever(onInbound);
    },

    sendText: (text) => postMessage({ type: 'text', format: 'plain', text }),

    async sendImage(png, name) {
      const boundary = `pacepay-${randomUUID()}`;
      const meta = JSON.stringify({ contentType: 'image/png', sizeBytes: png.length, filename: name });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: image/png\r\n\r\n`),
        png,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const res = await fetch(`${project}/attachments`, {
        method: 'POST',
        headers: headers({
          'content-type': `multipart/related; boundary=${boundary}`,
          'content-length': String(body.length),
          'idempotency-key': `pacepay:${randomUUID()}`,
        }),
        body,
      });
      if (!res.ok) await fail('attachment upload', res);
      const att = (await res.json()) as { id?: string };
      if (!att.id) throw new Error('Photon attachment upload returned no id');
      return postMessage({ type: 'attachment', attachmentId: att.id });
    },

    async fetchImage(ref) {
      const res = await fetch(`${project}/attachments/${encodeURIComponent(ref)}/content`, { headers: headers() });
      if (!res.ok) await fail('attachment download', res);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
