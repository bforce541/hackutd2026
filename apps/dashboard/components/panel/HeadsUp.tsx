/** Heads up: the outcome, the best fix with one button, the other fixes as rows. Owned by: dash-panel. */
import { formatDate, formatMoney } from '@pacepay/shared';
import type { DashboardProps } from '@/lib/view-model';
import { Divider, Eyebrow, Headline, Muted, Note, OptionRowButton, OptionTitle, PrimaryButton, type StepOf } from './primitives';

export function HeadsUp({ view, state, actions }: DashboardProps & { view: StepOf<'heads_up'> }) {
  const day0 = state.household.day0Date;
  // Vermilion means overdrawn and only that; a dip under the minimum alone is a limits matter (ochre).
  const overdrawn = view.lowest.amount < 0;
  return (
    <div className="flex flex-col">
      <Eyebrow className={overdrawn ? 'text-vermilion' : 'text-ochre'}>Heads up</Eyebrow>
      <Headline>
        {formatMoney(view.lowest.amount)} on {formatDate(view.lowest.day, day0)}
      </Headline>
      <Muted className="mt-[0.375em]">{view.condition}</Muted>
      <Divider className="my-[1.25em]" />
      <Eyebrow className="text-green">Best fix</Eyebrow>
      <OptionTitle>{view.best.title}</OptionTitle>
      <Muted className="mt-[0.25em]">{view.best.detail}</Muted>
      <PrimaryButton className="mt-[1em]" onClick={() => actions.pickOption(view.best.optionId)}>
        {view.best.cta}
      </PrimaryButton>
      {view.others.length > 0 && (
        <>
          <Note className="mt-[1.5em] mb-[0.25em]">Other options</Note>
          {view.others.map((o) => (
            <OptionRowButton key={o.optionId} title={o.title} detail={o.detail} onClick={() => actions.pickOption(o.optionId)} />
          ))}
        </>
      )}
    </div>
  );
}
