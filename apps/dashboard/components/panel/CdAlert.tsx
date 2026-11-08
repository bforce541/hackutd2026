/** CD alert (day 11): what's coming up, the best use, and one other option. Owned by: dash-panel. */
import { formatDate, formatMoney } from '@pacepay/shared';
import type { DashboardProps } from '@/lib/view-model';
import { ButtonRow, Divider, Eyebrow, Headline, Muted, Note, OptionTitle, PrimaryButton, SecondaryButton, type StepOf } from './primitives';

export function CdAlert({ view, state, actions }: DashboardProps & { view: StepOf<'cd_alert'> }) {
  return (
    <div className="flex flex-col">
      <Eyebrow className="text-muted">Coming up</Eyebrow>
      <Headline>
        Your {formatMoney(view.cdAmount)} CD matures {formatDate(view.maturesOn, state.household.day0Date)}
      </Headline>
      <Divider className="my-[1.25em]" />
      <Eyebrow className="text-green">Best use</Eyebrow>
      <OptionTitle>{view.best.title}</OptionTitle>
      <Muted className="mt-[0.25em]">{view.best.detail}</Muted>
      <ButtonRow className="mt-[1em]">
        <PrimaryButton className="flex-auto px-[1em]" onClick={actions.compareCdInWhatIf}>
          Compare in what-if
        </PrimaryButton>
        <SecondaryButton className="flex-none px-[1.25em]" onClick={actions.dismissCdAlert}>
          Later
        </SecondaryButton>
      </ButtonRow>
      <Note className="mt-[1.5em] mb-[0.25em]">Other option</Note>
      <div className="flex items-baseline gap-[0.75em] border-y border-hairline py-[0.625em]">
        <span className="min-w-0 flex-auto font-medium">{view.other.title}</span>
        <span className="flex-none text-[0.875em] text-muted">{view.other.detail}</span>
      </div>
      <Note className="mt-[0.75em]">You make the move at your bank. PacePay never moves money.</Note>
    </div>
  );
}
