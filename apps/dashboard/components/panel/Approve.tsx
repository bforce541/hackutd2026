/** Approve, the second approval: before -> after rows and two equal buttons. Owned by: dash-panel. */
import { formatTimer } from '@pacepay/shared';
import type { DashboardProps } from '@/lib/view-model';
import { ButtonRow, DefRows, Eyebrow, Muted, PrimaryButton, SecondaryButton, Title, type StepOf } from './primitives';

export function Approve({ view, actions }: DashboardProps & { view: StepOf<'approve'> }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline gap-[0.5em]">
        {view.termsChanged ? (
          <Eyebrow className="text-ochre">Terms changed</Eyebrow>
        ) : (
          <Eyebrow className="text-muted">Lender&apos;s offer</Eyebrow>
        )}
        {view.secondsLeft !== undefined && (
          <span className="ml-auto text-label text-muted">{formatTimer(view.secondsLeft)} left</span>
        )}
      </div>
      <Title>{view.termsChanged ? 'Approve the new terms?' : 'Approve this deal?'}</Title>
      {view.termsChanged && <Muted className="mt-[0.375em]">{view.termsChanged.note}</Muted>}
      <DefRows
        valueClassName=""
        rows={view.rows.map((r) => ({
          label: r.label,
          value: (
            <>
              <span className="text-muted">{r.before} →</span> <strong className="font-semibold">{r.after}</strong>
            </>
          ),
        }))}
      />
      <ButtonRow>
        <PrimaryButton className="flex-1" onClick={actions.approveDeal}>
          Approve
        </PrimaryButton>
        <SecondaryButton className="flex-1 border-[1.5px] border-before-line" onClick={actions.decline}>
          Decline
        </SecondaryButton>
      </ButtonRow>
    </div>
  );
}
