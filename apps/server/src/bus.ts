/**
 * Activity events and the SSE fan-out. Implemented by: server-core.
 *
 * One counter numbers every SSE message; an activity event's `seq` is the seq of the SSE message
 * that carries it, so the dashboard can order both the same way and resume with Last-Event-ID.
 */
import type { ActivityEvent, ActivityInput, SseEvent, SseEventInput } from '@pacepay/shared';
import { newId, nowIso } from './ids';

export type Unsubscribe = () => void;

export interface Bus {
  /** Record one activity event (SPEC rule 4: every agent step emits one) and publish it as `activity`. */
  emit(activity: ActivityInput): ActivityEvent;
  /** Publish any SSE event. Returns it with its seq. */
  publish(event: SseEventInput): SseEvent;
  /** Receive every event published from now on. */
  subscribe(fn: (event: SseEvent) => void): Unsubscribe;
  /** Buffered events with seq > `seq`, oldest first, for Last-Event-ID resume. */
  since(seq: number): SseEvent[];
  lastSeq(): number;
}

export interface BusOptions {
  /** Called with each activity event, e.g. to append it to the store. */
  onActivity?: (e: ActivityEvent) => void;
  /** Start numbering after this seq (restored from a snapshot). */
  startSeq?: number;
  /** How many events to keep for replay. */
  replaySize?: number;
}

export function createBus(opts: BusOptions = {}): Bus {
  let seq = opts.startSeq ?? 0;
  const replaySize = opts.replaySize ?? 2000;
  const buffer: SseEvent[] = [];
  const subs = new Set<(e: SseEvent) => void>();

  // A subscriber may publish while an event is being delivered (the agent follows an approval by
  // publishing the case). Those events wait in `pending` so every subscriber sees seq order; the
  // SSE writer skips any seq lower than one it already sent, so out-of-order delivery lost events.
  const pending: SseEvent[] = [];
  let delivering = false;

  function deliver(e: SseEvent): void {
    buffer.push(e);
    if (buffer.length > replaySize) buffer.splice(0, buffer.length - replaySize);
    pending.push(e);
    if (delivering) return;
    delivering = true;
    try {
      while (pending.length) {
        const next = pending.shift()!;
        for (const fn of subs) {
          try {
            fn(next);
          } catch (err) {
            console.error('[bus] subscriber threw', err);
          }
        }
      }
    } finally {
      delivering = false;
    }
  }

  return {
    emit(input) {
      const s = ++seq;
      const activity: ActivityEvent = { ...input, id: newId('act'), seq: s, at: input.at ?? nowIso() };
      opts.onActivity?.(activity);
      deliver({ event: 'activity', seq: s, data: activity });
      return activity;
    },
    publish(input) {
      const e = { ...input, seq: ++seq } as SseEvent;
      deliver(e);
      return e;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    since(after) {
      return buffer.filter((e) => e.seq > after);
    },
    lastSeq() {
      return seq;
    },
  };
}
