/** Nothing needs Yoshua: one calm line, the status restated. Owned by: dash-panel. */
import type { DashboardProps } from '@/lib/view-model';
import { CHECK_PATH, Eyebrow, MarkIcon, Muted, Title } from './primitives';

export function Idle({ state }: DashboardProps) {
  const paused = state.rules.paused ?? false;
  return (
    <div className="flex flex-col">
      <Eyebrow className="flex items-center gap-[0.375em] text-green">
        {!paused && <MarkIcon path={CHECK_PATH} color="var(--green)" />}
        {paused ? 'Paused' : 'All set'}
      </Eyebrow>
      <Title>{paused ? "PacePay won't text or call" : 'Nothing needs you right now'}</Title>
      <Muted className="mt-[0.375em]">{state.chart.status}</Muted>
    </div>
  );
}
