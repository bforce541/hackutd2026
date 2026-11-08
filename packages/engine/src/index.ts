// @pacepay/engine: SPEC.md section 3. Pure functions: no I/O, no clock, no randomness.

export * from './types';
export { addMonths, BANK_TRANSFER_KINDS, dateToDay, dayToDate, isWeekend, postingDay, shortDate, weekday } from './calendar';
export { accountsDrawnFrom, applyChanges, cardAccounts, checkingAccount, findAccount, savingsAccount } from './changes';
export { CHART_HORIZON_DAYS, forecast, SCORE_HORIZON_DAYS, type ForecastOptions } from './forecast';
export { balancesOn, occurrences, postingDays, project, type AccountLedger, type Posting } from './ledger';
export { formatMoney, formatMonths, formatPercent, formatPercent1, monthlyInterest, yearlyInterest } from './money';
export { CALL_SEARCH_DAYS, checkOffer, offerChanges, planCallTargets, type OfferContext, type OfferInput } from './offers';
export { billChange, buildOptions, cdOptions, monthlyCardSpend, type Bill } from './options';
export { grossMonthlyIncome, healthScores, householdOn, monthlyDebtPayments, monthlyEssentialsTotal, netWorth } from './scores';
export { simulate } from './simulate';
export { fixtures } from '../fixtures/household';
