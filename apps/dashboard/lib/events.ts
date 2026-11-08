/**
 * The SSE client for GET /api/events (SPEC §4). Owned by: dash-shell.
 * EventSource resumes with Last-Event-ID on its own; pass `lastSeq` from the snapshot so the
 * first connection skips what the snapshot already has.
 */
import { API, SSE_EVENT_NAMES, type SseEvent } from '@pacepay/shared';

export interface EventStreamOptions {
  baseUrl: string;
  lastSeq?: number;
  onEvent(e: SseEvent): void;
  onStatus?(status: 'open' | 'reconnecting'): void;
}

export function openEventStream(opts: EventStreamOptions): () => void {
  const url = new URL(API.events, opts.baseUrl);
  if (opts.lastSeq !== undefined) url.searchParams.set('lastEventId', String(opts.lastSeq));
  const es = new EventSource(url);
  es.onopen = () => opts.onStatus?.('open');
  es.onerror = () => opts.onStatus?.('reconnecting');
  for (const name of SSE_EVENT_NAMES) {
    es.addEventListener(name, (msg) => {
      const m = msg as MessageEvent<string>;
      opts.onEvent({ event: name, seq: Number(m.lastEventId), data: JSON.parse(m.data) } as SseEvent);
    });
  }
  return () => es.close();
}
