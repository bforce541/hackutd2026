'use client';
/**
 * The PacePay panel (UI.md "Home, right"): the only white card, one step at a time. Renders
 * state.panel: Heads up, Limits, Call (with "Negotiating by text" and the lender console),
 * Approve, Done, What-if, CD alert. Ported from design/mockup/Main.dc.html. Owned by: dash-panel.
 */
import type { DashboardProps } from '@/lib/view-model';
import { HeadsUp } from './panel/HeadsUp';
import { Limits } from './panel/Limits';
import { CallStep } from './panel/Call';
import { Approve } from './panel/Approve';
import { Done } from './panel/Done';
import { WhatIf } from './panel/WhatIf';
import { CdAlert } from './panel/CdAlert';
import { Idle } from './panel/Idle';

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
    case 'idle':
      return <Idle {...props} />;
  }
}

export function PacePayPanel(props: DashboardProps) {
  return (
    <section
      aria-label="PacePay"
      className="num min-w-0 self-start rounded-xl border border-hairline bg-panel p-[1.5em] leading-[1.45] text-ink shadow-panel"
    >
      <Step {...props} />
    </section>
  );
}
