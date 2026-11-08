import { billChange, fixtures, type Change, type Household } from '../src/index';

/** Dollars → cents, so tests read like v2.md. */
export const $ = (dollars: number) => Math.round(dollars * 100);

export const h: Household = fixtures.household;

/** v2.md: "The shop quotes $650", paid from checking today (day 0). */
export const REPAIR = { amount: $(650), day: 0, label: 'Northside Auto Service' };
export const payRepair: Change = billChange(h, REPAIR);

/** The demo week, day 0 (Sat, Nov 7) through day 6 (Fri, Nov 13). */
export const WEEK = { sat: 0, sun: 1, mon: 2, tue: 3, wed: 4, thu: 5, fri: 6 } as const;

/** The car payment and the Friday deal ($20 fee), as the server would apply it after the call. */
export const fridayDeal: Change[] = [
  payRepair,
  { type: 'move_item', itemId: 'auto_payment', toDay: WEEK.fri },
  { type: 'add_fee', day: WEEK.fri, amount: $(20), label: 'Fee to move the due date' },
];
