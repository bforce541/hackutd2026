import { ACCOUNT_IDS, billItemId, COUNTERPARTY_IDS, ITEM_IDS, movedItemPrefix } from '@pacepay/shared';
import { describe, expect, it } from 'vitest';
import { billChange, forecast } from '../src/index';
import { $, fridayDeal, h, WEEK } from './helpers';

// packages/shared/src/fixture-ids.ts must name exactly what the fixture has, or the server,
// demo mode and demo:e2e look up ids that don't exist. A rename on either side fails here.
describe('fixture ids (shared ↔ engine)', () => {
  it('every shared account id is a fixture account, and every fixture account is listed', () => {
    expect(Object.values(ACCOUNT_IDS).sort()).toEqual(h.accounts.map((a) => a.id).sort());
  });

  it('every shared item id is a fixture scheduled item, and every scheduled item is listed', () => {
    expect(Object.values(ITEM_IDS).sort()).toEqual(h.scheduled.map((s) => s.id).sort());
  });

  it('every shared counterparty id is a fixture counterparty, and every one is listed', () => {
    expect(Object.values(COUNTERPARTY_IDS).sort()).toEqual(h.counterparties.map((c) => c.id).sort());
  });

  it('the car payment is the movable loan payment to the auto lender', () => {
    const car = h.scheduled.find((s) => s.id === ITEM_IDS.carPayment);
    expect(car).toMatchObject({ kind: 'loan_payment', movable: true, counterpartyId: COUNTERPARTY_IDS.autoLender });
  });

  it('a moved payment matches movedItemPrefix()', () => {
    const fri = forecast(h, { days: 7, changes: fridayDeal }).days[WEEK.fri]!;
    const ids = fri.items.map((i) => i.itemId);
    expect(ids.some((id) => id.startsWith(movedItemPrefix(ITEM_IDS.carPayment)))).toBe(true);
  });

  it('billChange uses billItemId() when the bill has an id', () => {
    const c = billChange(h, { id: 'b1', amount: $(650), day: 0, label: 'Repair' });
    expect(c.type === 'add_item' && c.item.id).toBe(billItemId('b1'));
  });
});
