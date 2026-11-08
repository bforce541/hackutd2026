# apps/dashboard ownership

Next.js App Router, Tailwind v4, visx. Look and behavior: `UI.md`; reference behavior: `design/mockup/Main.dc.html` (`renderVals()`). Deploys to https://pacepay.work from this folder on every push to `main`, so `pnpm --filter @pacepay/dashboard build` must pass before you hand off.

Each file has one owner (a build stream). Edit only your own files. `lib/view-model.ts` is the contract; if you need a field or action added, say so in your report instead of editing it.

| Path | Stream | What it is |
|---|---|---|
| `app/layout.tsx`, `app/globals.css`, `app/page.tsx` | dash-shell | Fonts, design tokens, page composition by tab |
| `components/Header.tsx` | dash-shell | Logo, five tabs, demo controls, avatar |
| `lib/view-model.ts` | dash-shell | `DashboardState`, `Actions`, `PanelView` and friends (the contract) |
| `lib/data-source.ts` | dash-shell | `useDashboard()`: live when the server answers, else demo |
| `lib/live.ts`, `lib/api.ts`, `lib/events.ts`, `lib/cn.ts` | dash-shell | Live mode (snapshot + SSE), fetch client, SSE client, class helper |
| `components/PaceLine.tsx`, `lib/pace-line*.ts`, `components/pace-line/*` | dash-paceline | The visx pace line and its helpers (scales, step path, label placement) |
| `components/PacePayPanel.tsx`, `components/panel/*` | dash-panel | Every panel step: Heads up, Limits, Call + lender console, Approve, Done, What-if, CD alert |
| `components/MessagesTab.tsx`, `components/ActivityTab.tsx`, `components/messages/*`, `components/activity/*` | dash-tabs-a | Messages (coach chat) and Activity (plan checklist + log) |
| `components/AccountsTab.tsx`, `components/ArenaTab.tsx`, `components/HealthStats.tsx`, `components/accounts/*`, `components/arena/*` | dash-tabs-b | Accounts + Your rules, Arena, the four health stats |
| `lib/demo-*.ts` (`demo-data.ts`, `demo-machine.ts`, any new `demo-*.ts`) | dash-demo | Demo mode: the mockup's state machine producing `DashboardState` |
| `components/ui/*` | first stream that needs one; say so in your report | shadcn-style primitives (Button, Switch, Tooltip) on Radix |

## Rules

- Components take `({ state, actions }: DashboardProps)` and read only `state`. They never compute balances: the chart, offers and what-if numbers arrive computed.
- Format every amount and date with `@pacepay/shared` (`formatMoney`, `formatSignedMoney`, `formatAxisMoney`, `formatDate`, `formatPercent`, `formatMonths`), and give amounts the `num` class (tabular figures).
- Colors and sizes only from the tokens in `app/globals.css` (`bg-page`, `bg-panel`, `text-ink`, `text-muted`, `border-hairline`, `text-green`, `bg-green-tint`, `text-vermilion`, `text-ochre`, `text-hero`, `text-headline`, `text-stat`, `text-label`, `text-chart`; in SVG `var(--green)` etc.). No pills, badges, gradients or extra cards (UI.md "Don'ts").
- No emoji and no marketing words in UI text.
- Ids for the demo household (accounts, the car payment) come from `ACCOUNT_IDS` / `ITEM_IDS` in `@pacepay/shared`. The Activity checklist labels each step with `stepActor(step)` and `ACTOR_LABELS` (Yoshua for his decisions).
- Never call `@pacepay/engine` at module scope: until Yoshua lands it every function throws, and a throw at import breaks `next build` (and the Vercel deploy). Call it inside hooks or event handlers and fall back to the demo data on error.
- `next build` must not need the server: no fetches at build time, and the page stays a client component.
- No new dependencies. Check your work with `pnpm --filter @pacepay/dashboard typecheck` and `pnpm --filter @pacepay/dashboard build`.
