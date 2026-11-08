/**
 * Held: the deal did not finish, and nothing changed. Either Yoshua did not answer in time (the
 * lender is holding the offer) or the lender changed the terms after he approved. An amber pause
 * badge, a plain line on what happened, the offer or what moved, and a way to the thread.
 * Owned by: dash-panel.
 */
import type { CSSProperties } from 'react';
import type { DashboardProps } from '@/lib/view-model';
import { ButtonRow, DefRows, Eyebrow, Muted, Note, SecondaryButton, Title, type StepOf } from './primitives';

export function Held({ view, actions }: DashboardProps & { view: StepOf<'held'> }) {
  const changed = view.variant === 'terms_changed' && view.changed && view.changed.length > 0;
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-[0.75em]">
        <span
          aria-hidden="true"
          className="flex size-[2.5em] flex-none items-center justify-center rounded-full bg-amber"
          style={{ animation: 'pop 620ms var(--ease-out) both' }}
        >
          <svg viewBox="0 0 24 24" className="size-[55%]" fill="none">
            <rect x="6.5" y="5.5" width="3.8" height="13" rx="1.4" fill="#14130f" />
            <rect x="13.7" y="5.5" width="3.8" height="13" rx="1.4" fill="#14130f" />
          </svg>
        </span>
        <Eyebrow className="text-ochre">{changed ? 'Terms changed' : 'On hold'}</Eyebrow>
      </div>
      <Title>{view.title}</Title>
      <Muted className="mt-[0.375em]">{view.detail}</Muted>
      <div className="rise" style={{ '--d': '240ms', animationDuration: '520ms' } as CSSProperties}>
        {changed ? (
          <DefRows
            valueClassName=""
            rows={view.changed!.map((r) => ({
              label: r.label,
              value: (
                <>
                  <span className="text-muted">{r.was} →</span> <strong className="font-semibold">{r.now}</strong>
                </>
              ),
            }))}
          />
        ) : (
          <DefRows rows={view.offer} />
        )}
      </div>
      <Note className="mt-[0.75em]">Nothing changed on your accounts.</Note>
      <ButtonRow>
        <SecondaryButton read className="flex-1" onClick={() => actions.setTab('messages')}>
          Open Messages
        </SecondaryButton>
      </ButtonRow>
    </div>
  );
}
