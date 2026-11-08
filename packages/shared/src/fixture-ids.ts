/**
 * Canonical ids for the v2.md demo household, matching Yoshua's engine fixture
 * (packages/engine/fixtures/household.ts). The fixture is the source; keep these in step with it, so the stub agent, demo:e2e, the dashboard's demo mode and the tests
 * can refer to an account or a scheduled item without guessing.
 *
 * Amounts and days live only in the fixture (SPEC rule 2), never here.
 *
 * Code that only needs "the car payment" should still prefer finding it by shape (kind
 * 'loan_payment' on the auto loan, movable) where that is just as easy.
 */
export const ACCOUNT_IDS = {
  checking: 'checking',
  savings: 'savings',
  cd: 'cd',
  rothIra: 'ira',
  autoLoan: 'auto_loan',
  personalLoan: 'personal_loan',
  creditCard: 'card',
  mortgage: 'mortgage',
} as const;

export const ITEM_IDS = {
  paycheck: 'paycheck',
  mortgagePayment: 'mortgage_payment',
  carPayment: 'auto_payment', // the auto loan payment: kind 'loan_payment', movable, counterpartyId auto_lender
  personalLoanPayment: 'personal_payment',
  cardAutopay: 'card_autopay',
  utilities: 'utilities',
  phoneInternet: 'phone_internet',
  carInsurance: 'car_insurance',
  cardSpend: 'card_spend',
} as const;

export const COUNTERPARTY_IDS = {
  autoLender: 'auto_lender',
  mortgageServicer: 'mortgage_servicer',
  personalLender: 'personal_lender',
  cardIssuer: 'card_issuer',
  utility: 'utility',
} as const;

/** A moved payment gets the id `<itemId>@<day>` (Yoshua's engine); match on the prefix. */
export const movedItemPrefix = (itemId: string): string => `${itemId}@`;

/** The scheduled item id a bill's payment gets inside Case.baseChanges (an add_item change). */
export const billItemId = (billId: string): string => `bill:${billId}`;
