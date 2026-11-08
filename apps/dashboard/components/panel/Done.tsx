/**
 * Done: the payoff. A leaf badge pops and draws its own check, then "Covered through Dec 7", the
 * results, and What happened. Owned by: dash-panel.
 */
import type { CSSProperties } from 'react';
import { formatShortDate } from '@pacepay/shared';
import type { DashboardProps } from '@/lib/view-model';
import { DefRows, Eyebrow, SecondaryButton, Title, type DefRow, type StepOf } from './primitives';

export function Done({ view, state, actions }: DashboardProps & { view: StepOf<'done'> }) {
  const rows: DefRow[] = [...view.results];
  if (view.reference) rows.push({ label: 'Reference', value: view.reference });
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-[0.75em]">
        <span
          aria-hidden="true"
          className="flex size-[2.5em] flex-none items-center justify-center rounded-full bg-leaf"
          style={{ animation: 'pop 620ms var(--ease-out) both' }}
        >
          <svg viewBox="0 0 24 24" className="size-[55%]" fill="none">
            <path
              d="M5.5 12.5 L10 17 L18.5 7.5"
              stroke="#fff"
              strokeWidth="2.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              pathLength={1}
              strokeDasharray={1}
              style={{ animation: 'draw 640ms var(--ease-out) 260ms both' }}
            />
          </svg>
        </span>
        <Eyebrow className="text-green">Done</Eyebrow>
      </div>
      <Title>Covered through {formatShortDate(view.coveredThrough, state.household.day0Date)}</Title>
      {rows.length > 0 && (
        <div className="rise" style={{ '--d': '380ms', animationDuration: '520ms' } as CSSProperties}>
          <DefRows rows={rows} />
        </div>
      )}
      <SecondaryButton read className="mt-[1.25em]" onClick={actions.openActivity}>
        What happened
      </SecondaryButton>
    </div>
  );
}
