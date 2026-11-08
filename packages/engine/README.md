# @pacepay/engine

PacePay's money math (SPEC.md §3). Pure functions: no I/O, no clock, no randomness. The same input always gives the same output, so it runs in the server and in the browser (the what-if panel). Money is integer **cents**; days are integers from **day 0 = Sat, Nov 7, 2026**.

```bash
cd packages/engine
pnpm test        # 49 vitest tests; every v2.md number is asserted
pnpm typecheck
```

Every v2.md number has a test named after its v2.md line (`test/*.test.ts`). If a number changes in v2.md, change `fixtures/household.ts` and the test that names that line.

## The calls the server and dashboard make

```ts
import {
  fixtures, billChange, buildOptions, checkOffer, offerChanges, planCallTargets,
  cdOptions, forecast, healthScores, simulate, netWorth, shortDate,
} from '@pacepay/engine';

const h = fixtures.household;
const repair = { amount: 65_000, day: 0, label: 'Northside Auto Service' };
const pay = billChange(h, repair);                  // the repair paid from checking today

forecast(h, { changes: [pay] }).lowest;             // { amount: -30000, day: 3, causeItemIds: ['mortgage_payment', 'auto_payment'] }
healthScores(h, { changes: [pay] });                // 4 scores: value, display ('−$300'), color, reason, improve
buildOptions(h, repair);                            // card / savings / move_payment, unranked, with every trade-off number
planCallTargets(h, 'auto_payment', { baseChanges: [pay] });   // { targetDay: 6 (Fri, Nov 13), acceptableDays, feeLimit: 2500 }

checkOffer(h, { itemId: 'auto_payment', newDay: 6, fee: 2_000 }, { baseChanges: [pay] });
// { pass: true, affordable: true, withinLimits: true, postsOnDay: 6, lowest: { amount: 10000, day: 2 }, reasons: ['OK'] }

const deal = [pay, ...offerChanges(h, { itemId: 'auto_payment', newDay: 6, fee: 2_000 })];
simulate(h, deal);                                  // { forecast (60 days), scores, netWorth } for the what-if panel and "after the call"

cdOptions(h, 'cd', { fromDay: 11 });                // cd_renew ($205/yr) and cd_payoff_card ($2,214 payoff, $2,786 to savings)
shortDate(h, 6);                                    // 'Fri, Nov 13'
```

Speed on a laptop: `simulate` ≈ 0.6 ms, `checkOffer` ≈ 0.4 ms, `buildOptions` ≈ 4 ms. Safe to run on every what-if toggle.

## Behavior worth knowing

- **Ids in the fixture:** accounts `checking savings cd ira auto_loan personal_loan card mortgage`; scheduled items `paycheck mortgage_payment auto_payment personal_payment card_autopay utilities phone_internet car_insurance card_spend`. Only `auto_payment` and `personal_payment` are `movable`.
- **Posting:** bank transfers (`paycheck bill loan_payment card_autopay transfer`) dated on a weekend post the next Monday; card spending, fees and one-off charges post on their own day. On any day, deposits post before debits, so `intradayLow` is the lower of the day's opening and closing balance. A payment moved onto a payday still fails by rule (`PAYDAY_SAME_DAY`).
- **Moving a payment** (`move_item`, or `offerChanges`) moves one occurrence: the last one due on or before the new date. On day 0 that's Tuesday's car payment; after the clock jumps, the same call moves December's. The moved occurrence gets the id `auto_payment@<day>`; the series keeps its usual dates.
- **Causes** of a dip are the scheduled debits since the last credit. One-off charges (the repair) are the trigger, not a cause.
- **Horizons:** scores and offer checks look 30 days ahead from `fromDay`; `forecast` defaults to 60 days for the chart.
- **`checkOffer` reasons:** `OK` when it passes; otherwise any of `BELOW_FLOOR`, `NEGATIVE_BALANCE`, `PAYDAY_SAME_DAY`, `FEE_OVER_LIMIT`, plus the informational `WEEKEND_ROLLS_FORWARD`. Affordability and limits are separate flags.
- **CD payoff credit use after** is a month of normal card spending on the paid-off card ($710.67 ÷ $5,000 = 14%), which is what v2.md says ("about 14%, one month of spending"). SPEC §3's wording ("balance after the payoff ÷ limit") would give 0%; v2.md wins as the source of truth.

## Types

`src/types.ts` mirrors SPEC §2. When `@pacepay/shared` lands, that file becomes a re-export from it and nothing else changes.
