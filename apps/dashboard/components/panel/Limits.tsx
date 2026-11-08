/** Limits, the first approval: what PacePay may agree to before it calls. Owned by: dash-panel. */
import { formatDate, formatMoney } from '@pacepay/shared';
import type { DashboardProps } from '@/lib/view-model';
import { ButtonRow, DefRows, Eyebrow, Note, PrimaryButton, SecondaryButton, Title, type StepOf } from './primitives';

export function Limits({ view, state, actions }: DashboardProps & { view: StepOf<'limits'> }) {
  const callNow = () => {
    actions.approveLimits();
    // Demo: start the scripted call. Live: a no-op, the server dials after the OK.
    actions.startCall();
  };
  return (
    <div className="flex flex-col">
      <Eyebrow className="text-ochre">Your limits</Eyebrow>
      <Title>PacePay will call your lender</Title>
      <DefRows
        rows={[
          { label: 'Ask for', value: formatDate(view.askFor, state.household.day0Date) },
          { label: 'Most in fees', value: formatMoney(view.maxFee) },
          { label: 'New credit', value: view.newCredit },
        ]}
      />
      <Note className="mt-[0.75em]">It says it&apos;s an AI and never shares your balances.</Note>
      <ButtonRow>
        <PrimaryButton className="flex-1" onClick={callNow}>
          Call now
        </PrimaryButton>
        <SecondaryButton className="flex-1" onClick={actions.decline}>
          Cancel
        </SecondaryButton>
      </ButtonRow>
    </div>
  );
}
