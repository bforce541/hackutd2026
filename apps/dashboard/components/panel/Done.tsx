/** Done: "Covered through Dec 7", the results, and What happened. Owned by: dash-panel. */
import { formatShortDate } from '@pacepay/shared';
import type { DashboardProps } from '@/lib/view-model';
import { CHECK_PATH, DefRows, Eyebrow, MarkIcon, SecondaryButton, Title, type DefRow, type StepOf } from './primitives';

export function Done({ view, state, actions }: DashboardProps & { view: StepOf<'done'> }) {
  const rows: DefRow[] = [...view.results];
  if (view.reference) rows.push({ label: 'Reference', value: view.reference });
  return (
    <div className="flex flex-col">
      <Eyebrow className="flex items-center gap-[0.375em] text-green">
        <MarkIcon path={CHECK_PATH} color="var(--green)" />
        Done
      </Eyebrow>
      <Title>Covered through {formatShortDate(view.coveredThrough, state.household.day0Date)}</Title>
      {rows.length > 0 && <DefRows rows={rows} />}
      <SecondaryButton className="mt-[1.25em]" onClick={actions.openActivity}>
        What happened
      </SecondaryButton>
    </div>
  );
}
