/**
 * The watcher (SPEC §5.1 DAILY_CHECK): runs on every clock change and once per real day.
 * Raises CD_MATURING (a CD matures within 2 business days) or SHORTFALL (cushion red, no open
 * case), sends due follow-ups (the night-before reminder), and the 30-minute demo-clock
 * reminders for pending choices and limits. Implemented by: watcher.
 *
 * - Numbers come from ../forecast.ts; texts go through ../messaging/outbox.ts with unprompted: true
 *   (held during quiet hours or Pause; retry on the next check).
 * - The demo clock counts whole days, so the "30 minutes of demo-clock time" reminder (SPEC §5.4)
 *   runs on real time: 30 minutes after an option_choice, call_limits or bill_confirm approval
 *   was requested, if still pending, ctx.enqueue APPROVAL_TIMEOUT { reminder: true }. Once per approval.
 * - A follow-up's atTime ('20:00' for the night-before reminder) is display only; it is sent on
 *   the first check with day >= atDay.
 * - CD_MATURING fires once per CD (remember it in the case list: an open or done cd_maturing case
 *   for that account means skip).
 */
import type { Day } from '@pacepay/shared';
import type { ToolContext } from '../tools/registry';

export interface Watcher {
  /** Called by POST /api/demo/clock after it emits clock.changed. */
  onClockChange(day: Day): Promise<void>;
  /** Starts the once-per-real-day timer. */
  start(): void;
  stop(): void;
}

export function createWatcher(ctx: ToolContext): Watcher {
  return {
    async onClockChange(day) {
      ctx.bus.emit({ type: 'step.skipped', title: `Daily check for day ${day} skipped: watcher not implemented yet`, model: 'code', level: 'warn' });
    },
    start() {},
    stop() {},
  };
}
