/**
 * The watcher (SPEC §5.1 DAILY_CHECK): runs on every clock change and once per real day.
 * Raises CD_MATURING (a CD matures within 2 business days) or SHORTFALL (cushion red, no open
 * case), sends due follow-ups (the night-before reminder), and the 30-minute reminders for
 * pending choices, limits OKs and bill checks. Implemented by: watcher.
 *
 * - Numbers come from ../forecast.ts; texts go through ../messaging/outbox.ts with unprompted: true
 *   (held during quiet hours or Pause; the follow-up stays scheduled and retries on the next check).
 * - The demo clock counts whole days, so the 30-minute reminder runs on real time (a 60 s poll):
 *   30 minutes after an option_choice, call_limits or bill_confirm approval was requested, if
 *   still pending, ctx.enqueue APPROVAL_TIMEOUT { reminder: true }. Once per approval.
 * - A follow-up's atTime is display only; it is sent on the first check with day >= atDay.
 * - CD_MATURING fires once per CD (remembered per store state, so a demo reset starts fresh, and
 *   also skipped when a cd_maturing case already exists). SHORTFALL fires once per red spell.
 * - Checks run one at a time (a promise chain), so two quick clock jumps cannot double-fire.
 */
import {
  HORIZON_DAYS,
  REMINDER_AFTER_DEMO_MINUTES,
  isWeekend,
  type ApprovalKind,
  type Day,
  type Followup,
} from '@pacepay/shared';
import type { ToolContext } from '../tools/registry';
import { sendText, unpromptedHoldReason } from '../messaging/outbox';
import { currentForecast, currentScores } from '../forecast';
import { newId } from '../ids';

export interface Watcher {
  /** Called by POST /api/demo/clock after it emits clock.changed. */
  onClockChange(day: Day): Promise<void>;
  /** Starts the once-per-real-day timer. */
  start(): void;
  stop(): void;
}

/** A CD alert goes out when the CD matures within this many business days. */
const CD_WINDOW_BUSINESS_DAYS = 2;
const REMINDER_KINDS: readonly ApprovalKind[] = ['option_choice', 'call_limits', 'bill_confirm'];
const REMINDER_POLL_MS = 60_000;
const REAL_DAY_POLL_MS = 60 * 60_000;

/** What the watcher has already done, tied to one store state (a demo reset replaces it). */
interface Memory {
  cdFired: Set<string>;
  shortfallKey: string | null;
  reminded: Set<string>;
}

export function createWatcher(ctx: ToolContext): Watcher {
  const memories = new WeakMap<object, Memory>();
  let chain: Promise<void> = Promise.resolve();
  let reminderTimer: NodeJS.Timeout | null = null;
  let dayTimer: NodeJS.Timeout | null = null;
  let lastRealDate: string | null = null;
  /** True when an alert was held for quiet hours or Pause; the hourly tick re-runs the check. */
  let deferred = false;

  /**
   * The CD and shortfall alerts start a case whose first text is unprompted but goes out as an
   * approval prompt (never held), and a reminder is marked sent once raised. So the watcher holds
   * them itself during quiet hours or Pause (SPEC 5.3, UI.md) and retries on a later check.
   */
  function holdUnprompted(what: string): boolean {
    const reason = unpromptedHoldReason(ctx);
    if (!reason) return false;
    deferred = true;
    ctx.bus.emit({ type: 'step.skipped', model: 'code', level: 'warn', title: `Held the ${what} (${reason === 'paused' ? 'PacePay is paused' : 'quiet hours'}); will retry` });
    return true;
  }

  function memory(): Memory {
    const key = ctx.store.get();
    let m = memories.get(key);
    if (!m) {
      m = { cdFired: new Set(), shortfallKey: null, reminded: new Set() };
      memories.set(key, m);
    }
    return m;
  }

  const stamp = () => ({ id: newId('evt'), at: ctx.clock.now() });

  /** Business days in (from, to]. */
  function businessDaysBetween(from: Day, to: Day): number {
    const day0 = ctx.store.household().day0Date;
    let n = 0;
    for (let d = from + 1; d <= to; d++) if (!isWeekend(d, day0)) n++;
    return n;
  }

  function checkCds(day: Day, m: Memory): void {
    const cases = ctx.store.list('cases');
    for (const acct of ctx.store.household().accounts) {
      if (acct.kind !== 'cd' || acct.maturesOn === undefined) continue;
      const maturesOn = acct.maturesOn;
      if (maturesOn < day || businessDaysBetween(day, maturesOn) > CD_WINDOW_BUSINESS_DAYS) continue;
      const key = `${acct.id}@${maturesOn}`;
      if (m.cdFired.has(key) || cases.some((c) => c.kind === 'cd_maturing' && c.title.includes(acct.name))) continue;
      if (holdUnprompted(`CD alert for the ${acct.name}`)) continue;
      m.cdFired.add(key);
      ctx.bus.emit({ type: 'event.received', model: 'code', title: `Daily check: ${acct.name} matures on day ${maturesOn}, raising CD_MATURING`, detail: { accountId: acct.id, maturesOn } });
      ctx.enqueue({ ...stamp(), type: 'CD_MATURING', accountId: acct.id, maturesOn });
    }
  }

  function checkShortfall(m: Memory): void {
    const cushion = currentScores(ctx).find((s) => s.key === 'cash_cushion');
    if (!cushion || cushion.color !== 'red') {
      m.shortfallKey = null;
      return;
    }
    const open = ctx.store.currentCase();
    if (open && open.state !== 'DONE') return;
    const lowest = currentForecast(ctx, { days: HORIZON_DAYS }).lowest;
    const key = `${lowest.amount}@${lowest.day}`;
    if (m.shortfallKey === key) return;
    if (holdUnprompted('shortfall alert')) return;
    m.shortfallKey = key;
    ctx.bus.emit({ type: 'event.received', model: 'code', title: 'Daily check: cash cushion is red with no open case, raising SHORTFALL', detail: { lowest } });
    ctx.enqueue({ ...stamp(), type: 'SHORTFALL', lowest });
  }

  async function sendFollowups(day: Day): Promise<void> {
    for (const f of ctx.store.dueFollowups(day) as Followup[]) {
      try {
        const res = await sendText(ctx, f.text, { unprompted: true, caseId: f.caseId });
        if (!res.sent) continue; // quiet hours or paused: stays scheduled, retried on the next check
        ctx.store.patch('followups', f.id, { status: 'sent', sentAt: ctx.clock.now() });
        ctx.bus.emit({ type: 'step.completed', model: 'code', caseId: f.caseId, title: `Sent the scheduled follow-up (day ${f.atDay}${f.atTime ? ` ${f.atTime}` : ''})` });
      } catch (err) {
        ctx.bus.emit({ type: 'step.failed', model: 'code', caseId: f.caseId, level: 'error', title: `Follow-up ${f.id} failed: ${(err as Error).message}` });
      }
    }
  }

  function remindPending(): void {
    const m = memory();
    const limitMs = REMINDER_AFTER_DEMO_MINUTES * 60_000;
    const now = Date.parse(ctx.clock.now());
    for (const a of ctx.store.pendingApprovals()) {
      if (!REMINDER_KINDS.includes(a.kind) || m.reminded.has(a.id)) continue;
      if (now - Date.parse(a.requestedAt) < limitMs) continue;
      if (unpromptedHoldReason(ctx)) continue; // not marked: the next poll after quiet hours sends it
      m.reminded.add(a.id);
      ctx.bus.emit({ type: 'event.received', model: 'code', caseId: a.caseId, title: `${REMINDER_AFTER_DEMO_MINUTES} minutes with no answer on ${a.kind.replace('_', ' ')}: sending a reminder`, detail: { approvalId: a.id } });
      ctx.enqueue({ ...stamp(), type: 'APPROVAL_TIMEOUT', approvalId: a.id, caseId: a.caseId, reminder: true });
    }
  }

  async function dailyCheck(day: Day, reason: 'clock' | 'real_day'): Promise<void> {
    const m = memory();
    ctx.bus.emit({ type: 'step.started', model: 'code', title: `Daily check, day ${day} (${reason === 'clock' ? 'clock changed' : 'new real day'})` });
    try {
      checkCds(day, m);
      checkShortfall(m);
      await sendFollowups(day);
      remindPending();
      ctx.bus.emit({ type: 'step.completed', model: 'code', title: `Daily check for day ${day} done` });
    } catch (err) {
      ctx.bus.emit({ type: 'step.failed', model: 'code', level: 'error', title: `Daily check for day ${day} failed: ${(err as Error).message}` });
    }
  }

  function queue(day: Day, reason: 'clock' | 'real_day'): Promise<void> {
    chain = chain.then(() => dailyCheck(day, reason));
    return chain;
  }

  function realDate(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ctx.clock.now()));
  }

  function tickRealDay(): void {
    const today = realDate();
    if (today === lastRealDate && !deferred) return;
    lastRealDate = today;
    deferred = false;
    void queue(ctx.clock.today(), 'real_day');
  }

  return {
    onClockChange: (day) => queue(day, 'clock'),
    start() {
      if (reminderTimer || dayTimer) return;
      reminderTimer = setInterval(() => {
        try {
          remindPending();
        } catch (err) {
          ctx.bus.emit({ type: 'step.failed', model: 'code', level: 'error', title: `Reminder check failed: ${(err as Error).message}` });
        }
      }, REMINDER_POLL_MS);
      dayTimer = setInterval(tickRealDay, REAL_DAY_POLL_MS);
      reminderTimer.unref?.();
      dayTimer.unref?.();
      tickRealDay();
    },
    stop() {
      if (reminderTimer) clearInterval(reminderTimer);
      if (dayTimer) clearInterval(dayTimer);
      reminderTimer = dayTimer = null;
    },
  };
}
