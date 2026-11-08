'use client';
/**
 * Messages tab: the iMessage thread, shown on a phone so it reads as "this is what's on your
 * iPhone". PacePay's messages are white on the left, Yoshua's are ink on the right, chart images
 * inline. Beside it: tappable questions for the coach chat and the demo's "send the quote photo".
 * Anything typed or tapped is treated exactly like a text from Yoshua (actions.sendMessage).
 * Owned by: dash-tabs-a.
 */
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { LogoMark } from '@/components/Logo';
import type { DashboardProps } from '@/lib/view-model';
import { MessageBubble } from './messages/MessageBubble';

const GAP_MS = 60 * 60 * 1000;

const SUGGESTIONS = ['What did the lender say?', 'What if I skip the repair?', "How's my cash cushion?", 'Can I afford a $900 bill?'];

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
  const scroller = useRef<HTMLDivElement>(null);
  const count = state.thread.length;

  // Follow the thread inside the phone when a message arrives; never move the page.
  const seen = useRef(0);
  useEffect(() => {
    const el = scroller.current;
    if (el && count !== seen.current) el.scrollTo({ top: el.scrollHeight, behavior: seen.current === 0 ? 'auto' : 'smooth' });
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
    <section aria-labelledby="msg-h" className="mx-auto grid max-w-[64rem] items-center gap-10 py-2 lg:grid-cols-[24rem_minmax(0,1fr)] lg:gap-16">
      {/* The phone */}
      <div
        className="rise mx-auto flex h-[41rem] max-h-[calc(100vh-7rem)] w-full max-w-[24rem] flex-col overflow-hidden rounded-[3rem] border-[10px] border-[#17171a] bg-page shadow-panel ring-1 ring-hairline"
        style={{ '--d': '60ms' } as CSSProperties}
      >
        <div className="flex flex-none flex-col items-center gap-1.5 border-b border-hairline bg-panel/70 px-4 pb-3 pt-3 backdrop-blur">
          <span aria-hidden="true" className="h-[1.1rem] w-20 rounded-full bg-[#17171a]" />
          <span className="flex size-9 items-center justify-center rounded-full bg-[#0b0b0c]">
            <LogoMark size={20} />
          </span>
          <span className="text-chart font-medium">PacePay</span>
        </div>

        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3 [scrollbar-width:none]">
          <ol aria-label="Thread" className="m-0 flex list-none flex-col gap-1.5 p-0">
            {state.thread.map((m, i) => {
              const prev = state.thread[i - 1];
              const showTime = !prev || new Date(m.at).getTime() - new Date(prev.at).getTime() > GAP_MS;
              return (
                <Row key={m.id} time={showTime ? stamp(m.at) : null}>
                  <MessageBubble message={m} />
                </Row>
              );
            })}
          </ol>
        </div>

        <form onSubmit={send} className="flex flex-none items-center gap-2 border-t border-hairline bg-panel/70 px-3 py-2.5">
          <label htmlFor="pp-msg" className="sr-only">
            Message PacePay
          </label>
          <input
            id="pp-msg"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="iMessage"
            autoComplete="off"
            className="box-border min-h-10 min-w-0 flex-1 rounded-full border border-hairline bg-page px-4 text-label text-ink placeholder:text-muted"
          />
          <button
            type="submit"
            aria-label="Send"
            className="flex size-10 flex-none items-center justify-center rounded-full bg-ink text-page transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)] active:scale-90"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </form>
      </div>

      {/* Beside it */}
      <div className="rise min-w-0" style={{ '--d': '200ms' } as CSSProperties}>
        <p className="eyebrow text-muted">Messages · same thread as iMessage</p>
        <h2 id="msg-h" className="display m-0 mt-3 max-w-[14ch] text-[2.75rem]">
          Everything PacePay says, it said on your phone.
        </h2>
        <p className="mt-4 max-w-[34rem] text-body text-muted">
          It texts first only when it matters, shows its math, and never moves money without your yes. Ask it anything below: it answers from your real
          accounts.
        </p>

        <p className="eyebrow mt-8 text-muted">Try asking</p>
        <ul className="m-0 mt-3 flex list-none flex-wrap gap-2 p-0">
          {SUGGESTIONS.map((q) => (
            <li key={q}>
              <button
                type="button"
                onClick={() => actions.sendMessage(q)}
                className="min-h-10 rounded-full border border-hairline bg-panel px-4 text-label font-medium text-ink transition-[background-color,transform] duration-[var(--dur-base)] ease-[var(--ease-out)] hover:bg-secondary-hover active:scale-[0.97]"
              >
                {q}
              </button>
            </li>
          ))}
        </ul>

        <p className="eyebrow mt-8 text-muted">Demo</p>
        <button
          type="button"
          onClick={actions.injectBillPhoto}
          className="mt-3 min-h-11 rounded-full bg-ink px-5 text-label font-medium text-page transition-[opacity,transform] duration-[var(--dur-base)] ease-[var(--ease-out)] hover:opacity-90 active:scale-[0.97]"
        >
          Text PacePay the $650 repair quote
        </button>
      </div>
    </section>
  );
}

function Row({ time, children }: { time: string | null; children: React.ReactNode }) {
  return (
    <>
      {time ? <li className="eyebrow self-center pb-1 pt-2.5 text-muted">{time}</li> : null}
      {children}
    </>
  );
}
