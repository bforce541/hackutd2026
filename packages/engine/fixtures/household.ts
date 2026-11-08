// The v2.md demo household ("Demo household"), typed. v2.md is the source of truth:
// if a number changes there, change it here and in the test that names that v2.md line.
// Money is integer cents. Day 0 is Saturday, Nov 7, 2026.

import type { Household } from '../src/types';

const $ = (dollars: number) => Math.round(dollars * 100);

export const household: Household = {
  id: 'demo',
  person: { name: 'Yoshua', phoneEnv: 'CUSTOMER_PHONE' },
  day0Date: '2026-11-07',
  grossAnnualIncome: $(62_000),

  // $2,355 in bills and minimum payments plus $710 of card spending = $3,065
  monthlyEssentials: [
    { label: 'Mortgage', amount: $(1_200) },
    { label: 'Car payment', amount: $(400) },
    { label: 'Personal loan', amount: $(150) },
    { label: 'Card minimum', amount: $(85) },
    { label: 'Utilities', amount: $(220) },
    { label: 'Phone and internet', amount: $(120) },
    { label: 'Car insurance', amount: $(180) },
    { label: 'Card spending (groceries, gas)', amount: $(710) },
  ],

  accounts: [
    { id: 'checking', kind: 'checking', category: 'checking', name: 'Checking', isLiability: false, balance: $(1_950), reference: 'ending 2208' },
    { id: 'savings', kind: 'savings', category: 'savings', name: 'Savings', isLiability: false, balance: $(1_800), reference: 'ending 2216' },
    { id: 'cd', kind: 'cd', category: 'cds_iras', name: '12-month CD', isLiability: false, balance: $(5_000), apy: 0.041, maturesOn: 13, reference: 'ending 7730' },
    { id: 'ira', kind: 'ira', category: 'cds_iras', name: 'Roth IRA', isLiability: false, balance: $(14_200), offLimits: true, reference: 'ending 9051' },
    { id: 'auto_loan', kind: 'auto_loan', category: 'loans', name: 'Auto loan', isLiability: true, balance: $(13_400), apr: 0.069, minPayment: $(400), reference: 'ending 4417' },
    { id: 'personal_loan', kind: 'personal_loan', category: 'loans', name: 'Personal loan', isLiability: true, balance: $(3_100), apr: 0.119, minPayment: $(150), reference: 'ending 6182' },
    { id: 'card', kind: 'credit_card', category: 'credit_cards', name: 'Credit card', isLiability: true, balance: $(2_800), apr: 0.2499, limit: $(5_000), minPayment: $(85), reference: 'ending 3304' },
    { id: 'mortgage', kind: 'mortgage', category: 'mortgage', name: 'Mortgage', isLiability: true, balance: $(128_000), minPayment: $(1_200), assetValue: $(185_000), reference: 'ending 5529' },
  ],

  scheduled: [
    // Paycheck $2,000 every other Thursday, next one day 5
    { id: 'paycheck', accountId: 'checking', label: 'Paycheck', amount: $(2_000), day: 5, every: { days: 14 }, kind: 'paycheck' },
    // Mortgage $1,200/month, autopay Monday (day 2). Not movable: the demo negotiates the car payment.
    { id: 'mortgage_payment', accountId: 'checking', label: 'Mortgage', amount: -$(1_200), day: 2, every: { months: 1 }, kind: 'loan_payment', counterpartyId: 'mortgage_servicer', movable: false },
    // Auto loan $400/month, autopay Tuesday (day 3). The payment PacePay calls to move.
    { id: 'auto_payment', accountId: 'checking', label: 'Car payment', amount: -$(400), day: 3, every: { months: 1 }, kind: 'loan_payment', counterpartyId: 'auto_lender', movable: true },
    // Personal loan $150/month, due day 23
    { id: 'personal_payment', accountId: 'checking', label: 'Personal loan', amount: -$(150), day: 23, every: { months: 1 }, kind: 'loan_payment', counterpartyId: 'personal_lender', movable: true },
    // Credit card $750 autopay on day 12: out of checking, off the card balance
    { id: 'card_autopay', accountId: 'checking', label: 'Card autopay', amount: -$(750), counterAccountId: 'card', counterAmount: -$(750), day: 12, every: { months: 1 }, kind: 'card_autopay', counterpartyId: 'card_issuer' },
    // Other bills from checking
    { id: 'utilities', accountId: 'checking', label: 'Utilities', amount: -$(220), day: 9, every: { months: 1 }, kind: 'bill', counterpartyId: 'utility' },
    { id: 'phone_internet', accountId: 'checking', label: 'Phone and internet', amount: -$(120), day: 16, every: { months: 1 }, kind: 'bill' },
    { id: 'car_insurance', accountId: 'checking', label: 'Car insurance', amount: -$(180), day: 25, every: { months: 1 }, kind: 'bill' },
    // Everyday spending on the card: $164 each Saturday starting day 7 (about $710 a month). Never touches checking.
    { id: 'card_spend', accountId: 'card', label: 'Card spending', amount: $(164), day: 7, every: { days: 7 }, kind: 'card_spend' },
  ],

  rules: {
    checkingFloor: $(100),
    savingsFloor: $(1_500),
    feeLimit: $(25),
    offLimitsAccountIds: ['ira'],
  },

  // Fictional names. Ram's terms fixtures (fixtures/terms/*.md) use these ids.
  counterparties: [
    { id: 'auto_lender', name: 'Lone Star Auto Finance', kind: 'auto_lender', phoneEnv: 'LENDER_PHONE', termsDocIds: ['auto_loan'] },
    { id: 'mortgage_servicer', name: 'Prairie Home Lending', kind: 'mortgage_servicer', phoneEnv: 'LENDER_PHONE', termsDocIds: ['mortgage'] },
    { id: 'personal_lender', name: 'Cedar Personal Loans', kind: 'other', phoneEnv: 'LENDER_PHONE', termsDocIds: ['personal_loan'] },
    { id: 'card_issuer', name: 'Bluebonnet Card', kind: 'card_issuer', phoneEnv: 'LENDER_PHONE', termsDocIds: ['credit_card'] },
    { id: 'utility', name: 'North Texas Power', kind: 'utility', phoneEnv: 'LENDER_PHONE', termsDocIds: [] },
  ],
};

export const fixtures = { household };
