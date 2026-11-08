'use client';
/**
 * The PacePay panel: one thing at a time. Renders state.panel (Heads up, Limits, Call with the text
 * fallback, Approve, Done, What-if, CD alert). The five tiles at the top are the five steps of a
 * case; they light up in the spectrum as it moves from the problem (coral) to solved (leaf), and a
 * step change eases in instead of snapping. Owned by: dash-panel.
 */
import type { CSSProperties } from 'react';
import type { DashboardProps, PanelStep } from '@/lib/view-model';
import { HeadsUp } from './panel/HeadsUp';
import { Limits } from './panel/Limits';
import { CallStep } from './panel/Call';
import { Approve } from './panel/Approve';
import { Done } from './panel/Done';
import { WhatIf } from './panel/WhatIf';
import { CdAlert } from './panel/CdAlert';
import { Idle } from './panel/Idle';
import { Held } from './panel/Held';
import { BillConfirm } from './panel/BillConfirm';

function Step(props: DashboardProps) {
  const view = props.state.panel;
  switch (view.step) {
    case 'heads_up':
      return <HeadsUp {...props} view={view} />;
    case 'limits':
      return <Limits {...props} view={view} />;
    case 'call':
      return <CallStep {...props} />;
    case 'approve':
      return <Approve {...props} view={view} />;
    case 'done':
      return <Done {...props} view={view} />;
    case 'what_if':
      return <WhatIf {...props} />;
    case 'cd_alert':
      return <CdAlert {...props} view={view} />;
    case 'held':
      return <Held {...props} view={view} />;
    case 'bill_confirm':
      return <BillConfirm {...props} view={view} />;
    case 'idle':
      return <Idle {...props} />;
  }
}

/** The case's five steps, in order. Other panel views (idle, what-if, CD alert) are not part of one. */
const STEPS: { step: PanelStep; label: string }[] = [
  { step: 'heads_up', label: 'Heads up' },
  { step: 'limits', label: 'Limits' },
  { step: 'call', label: 'Call' },
  { step: 'approve', label: 'Approve' },
  { step: 'done', label: 'Done' },
];
const SPECTRUM = ['var(--coral)', 'var(--orange)', 'var(--amber)', 'var(--lime)', 'var(--leaf)'];

const OTHER_LABELS: Partial<Record<PanelStep, string>> = {
  idle: 'All set',
  what_if: 'What if',
  cd_alert: 'Coming up',
  bill_confirm: 'Check the bill',
};

export function PacePayPanel(props: DashboardProps) {
  const step = props.state.panel.step;
  // A held deal got as far as Approve, so its tiles stay lit through step 4 and Done stays dark.
  const index = step === 'held' ? 3 : STEPS.findIndex((s) => s.step === step);
  const inCase = index >= 0;
  const live = step === 'call';

  return (
    <section
      aria-label="PacePay"
      className="rise num min-w-0 self-start rounded-[1.75rem] border border-hairline bg-panel p-[1.5em] leading-[1.45] text-ink shadow-panel"
      style={{ '--d': '110ms' } as CSSProperties}
    >
      <h2 className="sr-only">PacePay agent</h2>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-label font-medium">
          <span className="relative flex size-2">
            {live && (
              <span
                aria-hidden="true"
                className="absolute inset-0 rounded-full bg-coral"
                style={{ animation: 'ring 1.6s var(--ease-out) infinite' }}
              />
            )}
            <span className="relative size-2 rounded-full" style={{ background: live ? 'var(--coral)' : 'var(--leaf)' }} />
          </span>
          PacePay
        </span>
        <span className="eyebrow text-muted">
          {step === 'held' ? 'On hold · 4/5' : inCase ? `${STEPS[index]!.label} · ${index + 1}/5` : (OTHER_LABELS[step] ?? '')}
        </span>
      </div>

      <div className="mt-3 mb-[1.25em] flex gap-1" role="img" aria-label={step === 'held' ? 'On hold after step 4 of 5' : inCase ? `Step ${index + 1} of 5: ${STEPS[index]!.label}` : 'No case open'}>
        {SPECTRUM.map((c, i) => {
          const lit = inCase && i <= index;
          return (
            <span
              key={c}
              aria-hidden="true"
              className="h-1.5 flex-1 rounded-full"
              style={{
                background: lit ? c : 'var(--hairline)',
                transition: `background-color 700ms var(--ease-out) ${i * 70}ms`,
              }}
            />
          );
        })}
      </div>

      {props.state.readOnly && (
        <p className="eyebrow mb-[1.25em] mt-0 rounded-xl bg-secondary-hover px-3 py-2 text-muted">
          View only · actions run on the presenter&apos;s laptop
        </p>
      )}

      {/* Keyed by step, so each step eases in; the panel's height follows its content */}
      <div key={step} className="rise" style={{ '--d': '0ms', animationDuration: '480ms' } as CSSProperties}>
        <Step {...props} />
      </div>
    </section>
  );
}
