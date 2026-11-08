/**
 * Bill check: PacePay read a bill but is not sure, so it asks before it works out options. Shows
 * what it read (merchant, amount, due date), why it is asking, and two ways out: yes, or fix it by
 * text ("it's $700"). Owned by: dash-panel.
 */
import { formatMoney } from '@pacepay/shared';
import type { DashboardProps } from '@/lib/view-model';
import { ButtonRow, DefRows, Eyebrow, Note, PrimaryButton, SecondaryButton, Title, type StepOf } from './primitives';

export function BillConfirm({ view, actions }: DashboardProps & { view: StepOf<'bill_confirm'> }) {
  return (
    <div className="flex flex-col">
      <Eyebrow className="text-ochre">Check the bill</Eyebrow>
      <Title>Is this bill right?</Title>
      <DefRows
        rows={[
          { label: 'From', value: view.merchant },
          { label: 'Amount', value: formatMoney(view.amount) },
          { label: 'Due', value: view.due },
        ]}
      />
      <Note className="mt-[0.75em]">
        {view.note || 'PacePay wasn’t sure about one detail.'} If it’s off, text the right amount, like “it’s $700”.
      </Note>
      <ButtonRow>
        <PrimaryButton className="flex-1" onClick={() => actions.confirmBill?.()}>
          Yes, that&apos;s right
        </PrimaryButton>
        <SecondaryButton read className="flex-1" onClick={() => actions.setTab('messages')}>
          Fix it
        </SecondaryButton>
      </ButtonRow>
    </div>
  );
}
