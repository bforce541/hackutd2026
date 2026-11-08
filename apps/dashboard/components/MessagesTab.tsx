'use client';
/**
 * Messages tab (UI.md): the iMessage thread mirrored in a centered 640px column, PacePay's
 * messages in white boxes on the left, Yoshua's in a green tint on the right, chart images
 * inline, "Same thread as iMessage", and a "Message PacePay" input (actions.sendMessage).
 * Owned by: dash-tabs-a.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { DashboardProps } from '@/lib/view-model';
import { MessageBubble } from './messages/MessageBubble';

const GAP_MS = 60 * 60 * 1000;

function stamp(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  });
}

export function MessagesTab({ state, actions }: DashboardProps) {
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLLIElement>(null);
  const count = state.thread.length;

  // Follow the thread when a message arrives, but don't jump the page when the tab opens.
  const seen = useRef(count);
  useEffect(() => {
    if (count > seen.current) endRef.current?.scrollIntoView?.({ block: 'nearest' });
    seen.current = count;
  }, [count]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    actions.sendMessage(text);
    setDraft('');
  };

  return (
    <section aria-labelledby="msg-h" className="mx-auto max-w-[640px]">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h2 id="msg-h" className="m-0 text-[1.25rem] font-semibold">
          Messages
        </h2>
        <span className="text-label text-muted">Same thread as iMessage</span>
      </div>
      <ol aria-label="Thread" className="m-0 flex list-none flex-col gap-2 p-0">
        {state.thread.map((m, i) => {
          const prev = state.thread[i - 1];
          const showTime = !prev || new Date(m.at).getTime() - new Date(prev.at).getTime() > GAP_MS;
          return (
            <FragmentRow key={m.id} time={showTime ? stamp(m.at) : null}>
              <MessageBubble message={m} />
            </FragmentRow>
          );
        })}
        <li ref={endRef} aria-hidden="true" className="h-0" />
      </ol>
      <form onSubmit={send} className="mt-5 flex gap-2">
        <label htmlFor="pp-msg" className="sr-only">
          Message PacePay
        </label>
        <input
          id="pp-msg"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message PacePay"
          autoComplete="off"
          className="box-border min-h-11 min-w-0 flex-1 rounded-lg border border-hairline bg-panel px-3.5 text-ink placeholder:text-muted"
        />
        <button
          type="submit"
          className="min-h-11 flex-none cursor-pointer rounded-lg border-0 bg-green px-5 font-semibold text-white"
        >
          Send
        </button>
      </form>
    </section>
  );
}

function FragmentRow({ time, children }: { time: string | null; children: React.ReactNode }) {
  return (
    <>
      {time ? <li className="self-center pb-1 pt-2 text-chart text-muted">{time}</li> : null}
      {children}
    </>
  );
}
