/**
 * The one way PacePay's texts reach Yoshua, and the one way his messages enter the thread.
 * Implemented by: server-core. Every stream that texts (send_message, send_chart,
 * request_approval, post_call_summary, the stub agent, the watcher) goes through sendText /
 * sendImage; the router records inbound messages with recordInbound. Nothing else touches
 * store.appendMessage or the `thread` SSE event.
 *
 * Each call: send through the MessagingPort (Photon or console), append a Message to the thread
 * mirror, emit `message.out` / `message.in` (activity) and publish `thread` (SSE).
 *
 * Quiet hours and Pause (SPEC §5.3, UI.md): a text with `unprompted: true` (the watcher's CD
 * alert, a shortfall alert, reminders, follow-ups) is held back during rules.quietHours (real
 * time, America/Chicago) or while rules.paused; it is not sent and the result says why, so the
 * caller can retry later. Replies to Yoshua and mid-call approvals are never unprompted.
 * PACEPAY_IGNORE_QUIET_HOURS=1 turns the quiet-hours check off for night rehearsals.
 */
import { mediaUrl, type Message, type ModelRole, type QuietHours, type Rules } from '@pacepay/shared';
import type { ToolContext } from '../tools/registry';
import { newId } from '../ids';
import { env } from '../env';

type Ctx = Pick<ToolContext, 'store' | 'bus' | 'messaging' | 'clock'>;

export interface OutboundOptions {
  /** True for texts PacePay starts on its own (watcher). Default false. */
  unprompted?: boolean;
  caseId?: string;
  stepId?: string;
  /** Feed label; default 'code'. */
  model?: ModelRole;
}

export type OutboundResult =
  | { sent: true; message: Message; providerId: string }
  | { sent: false; reason: 'quiet_hours' | 'paused' };

const TZ = 'America/Chicago';

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** True when `iso` falls inside quiet hours (which may wrap past midnight, e.g. 21:00 to 08:00). */
export function inQuietHours(q: QuietHours | undefined, iso: string, timeZone = TZ): boolean {
  if (!q) return false;
  const parts = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).formatToParts(new Date(iso));
  const now = Number(parts.find((p) => p.type === 'hour')?.value) * 60 + Number(parts.find((p) => p.type === 'minute')?.value);
  const start = minutesOf(q.start);
  const end = minutesOf(q.end);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

function heldBack(ctx: Ctx, rules: Rules, opts: OutboundOptions): 'quiet_hours' | 'paused' | null {
  if (!opts.unprompted) return null;
  if (rules.paused) return 'paused';
  if (env('PACEPAY_IGNORE_QUIET_HOURS') !== '1' && inQuietHours(rules.quietHours, ctx.clock.now())) return 'quiet_hours';
  return null;
}

/**
 * Why an unprompted text would be held right now (quiet hours or Pause), or null. The watcher
 * asks before it starts a case whose first text is unprompted (the CD alert, a shortfall alert),
 * because those texts go out as approval prompts, which are never held themselves.
 */
export function unpromptedHoldReason(ctx: Ctx): 'quiet_hours' | 'paused' | null {
  return heldBack(ctx, ctx.store.rules(), { unprompted: true });
}

function record(ctx: Ctx, m: Message, opts: OutboundOptions, title: string): void {
  ctx.store.appendMessage(m);
  ctx.bus.emit({ type: m.direction === 'out' ? 'message.out' : 'message.in', model: opts.model ?? 'code', caseId: opts.caseId, stepId: opts.stepId, title, detail: { messageId: m.id } });
  ctx.bus.publish({ event: 'thread', data: m });
}

function preview(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? `${one.slice(0, 77)}...` : one;
}

export async function sendText(ctx: Ctx, text: string, opts: OutboundOptions = {}): Promise<OutboundResult> {
  const reason = heldBack(ctx, ctx.store.rules(), opts);
  if (reason) {
    ctx.bus.emit({ type: 'message.out', model: 'code', caseId: opts.caseId, level: 'warn', title: `Held a text (${reason === 'paused' ? 'PacePay is paused' : 'quiet hours'}): ${preview(text)}` });
    return { sent: false, reason };
  }
  const { id: providerId } = await ctx.messaging.sendText(text);
  const message: Message = { id: newId('msg'), direction: 'out', channel: 'imessage', text, at: ctx.clock.now() };
  record(ctx, message, opts, `Texted Yoshua: ${preview(text)}`);
  return { sent: true, message, providerId };
}

/** Stores the PNG as media, sends it, and mirrors it with imageUrl = /api/media/:id. */
export async function sendImage(
  ctx: Ctx,
  png: Buffer,
  name: string,
  opts: OutboundOptions & { source?: 'chart' | 'fixture' } = {},
): Promise<OutboundResult & { mediaId?: string }> {
  const reason = heldBack(ctx, ctx.store.rules(), opts);
  if (reason) return { sent: false, reason };
  const meta = ctx.store.putMedia({ id: newId('media'), contentType: 'image/png', name, source: opts.source ?? 'chart' }, png);
  const { id: providerId } = await ctx.messaging.sendImage(png, name);
  const message: Message = { id: newId('msg'), direction: 'out', channel: 'imessage', imageUrl: mediaUrl(meta.id), at: ctx.clock.now() };
  record(ctx, message, opts, `Sent Yoshua an image: ${name}`);
  return { sent: true, message, providerId, mediaId: meta.id };
}

/**
 * Records a message from Yoshua (iMessage, coach chat, or a demo injection) in the thread.
 * Images must already be stored with store.putMedia; pass the media id.
 */
export function recordInbound(
  ctx: Ctx,
  m: { text?: string; mediaId?: string; channel: Message['channel']; at?: string },
): Message {
  const message: Message = {
    id: newId('msg'),
    direction: 'in',
    channel: m.channel,
    text: m.text,
    imageUrl: m.mediaId ? mediaUrl(m.mediaId) : undefined,
    at: m.at ?? ctx.clock.now(),
  };
  record(ctx, message, { model: 'code' }, m.text ? `Yoshua: ${preview(m.text)}` : 'Yoshua sent a photo');
  return message;
}
