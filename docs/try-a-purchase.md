# Try a purchase: build plan

A box in the dashboard's What-if panel where anyone types an amount ("$900") and watches the pace line, the lowest balance and the health scores react. It is the PNC "what if" simulator made hands-on: a judge types their own number. If the purchase breaks a floor, one tap hands it to PacePay as a new case.

## Status

- **Done and pushed:** `apps/dashboard/lib/purchase.ts` (the engine call and the framing) and `purchase.test.ts` (8 tests). New files only. Nothing user-facing changes yet.
- **Not started:** the UI and the wiring below. Waits until it can't collide with Ram's agents.

## What it shows

Type an amount, pick Checking or Card. The panel shows:

- Lowest balance in the window: `$350 → −$300`, and the day it hits.
- Days below $0, and how the four health scores change (only the ones that move).
- A verdict: **fine**, **tight** (breaks the $100 floor) or **overdrawn**. Never "you can afford it"; it shows the numbers and lets Yoshua decide (the same rule the texts follow).
- When the purchase breaks a floor: PacePay's best fix, and a button that starts the repair-quote flow for that amount.
- The pace line draws the after-purchase line, with the current plan as the gray dashed ghost.

## Why this design leaves Ram's files alone

The what-if toggles live in `UiState`, which `demo-machine.ts` builds in full, so adding a field there would mean editing it. Instead the typed amount lives in the page itself:

1. `lib/purchase.ts` is a pure function of `rules`, the accepted changes, the day, the amount and Checking or Card. It reads the fixture household straight from `@pacepay/engine`, so it needs nothing from either data source.
2. A new hook, `lib/with-purchase.ts`, takes whatever `useDashboard()` returns and, while a purchase is being tried, returns the same state with `chart` replaced and a `purchase` view attached. Demo and live both pass through it unchanged.
3. `view-model.ts` gets **optional** additions only (`purchase?` on `DashboardState`, `setPurchase?` on `Actions`), so `demo-machine.ts` and `live.ts` still typecheck without edits.

## Files

| File | Change | Ram's lane? |
|---|---|---|
| `lib/purchase.ts`, `lib/purchase.test.ts` | new, done | no |
| `lib/with-purchase.ts` | new | no |
| `components/panel/TryPurchase.tsx` | new | no |
| `components/panel/WhatIf.tsx` | render the box under the toggles | no |
| `lib/view-model.ts` | two optional fields | no |
| `app/page.tsx` | wrap `useDashboard()` in the hook (two lines) | no |
| `lib/demo-machine.ts`, `ArenaTab.tsx`, anything in `apps/server`, `apps/voice`, `packages/*` | **not touched** | yes |

## "Ask PacePay to fix it"

Live mode: reuses the existing bill photo or typed-bill route to open a case for that amount (`POST /api/demo/bill-photo` takes a fixture today, so this needs either a typed-bill endpoint or Ram's OK to reuse the Messages path: a text like "I have a $900 bill"). Demo mode: restart the scripted case with that amount. **Ask Ram before building this part.** Everything above it works without the server.

## Checks before it ships

- Typecheck, all tests, dashboard build.
- Every number matches the engine: $650 on checking is −$300 on Tue, Nov 10 (v2.md); the same $650 on the card leaves checking alone and moves credit use.
- Looked at in Light, Night, Presenter and a phone-width window. Keyboard only: type, Tab to Checking or Card, Enter.
- Empty, zero, negative and huge amounts show a calm hint, never a broken chart.
- View-only mode: the box still works (it only reads), the "fix it" button is dimmed.

## Freeze

Done and pushed by about 6 AM Sunday, or cut. The dashboard is frozen at 10 AM, because every push to `main` redeploys pacepay.work.
