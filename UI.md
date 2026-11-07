# PacePay UI direction

How PacePay looks and behaves. It's based on usability research, accessibility standards and the best money apps, with sources at the bottom. Lines marked *(judgment)* are design calls, not research findings. **For anything visual, this file overrides `v2.md` and `SPEC.md`.**

## The eight rules

1. **Lead with the answer.** Every screen opens with one plain sentence about the situation, and the chart's most prominent feature matches it: "You'd be overdrawn by about $300 on Tue, Nov 10."
2. **Numbers, not adjectives.** Show the amount, the date and what each option costs.
3. **Never rely on color alone.** Every state also gets a word and a shape.
4. **Don't judge.** Health scores say "On track" or "Room to grow." No grades, no red, no single combined score.
5. **Alert only when it matters.** That means the forecast crossing your minimum or $0. Keep one conversation per problem, and update it instead of sending a new alert.
6. **The person decides.** PacePay proposes, and you approve twice: first the limits, before it calls anyone, then the final deal.
7. **Show evidence, not reasoning.** Approval screens show before/after numbers and what was shared, not the model's explanation.
8. **Calm, legible, still.** Light theme, one typeface, five colors, no decorative motion.

## Look and feel

**Type**
- One family: Inter (fallback: system UI), in weights 400 and 600.
- Turn on tabular figures (`font-variant-numeric: tabular-nums`) wherever amounts appear, so digits line up.
- Sizes for an expo laptop read from about 6 feet away *(judgment)*:

  | Element | Size |
  |---|---|
  | Headline sentence | 32px |
  | Hero number | 56–72px |
  | Card values | 32–40px |
  | Body | 18px |
  | Chart labels | 16px or larger |
  | Smallest text anywhere | 14px |

**Color: five roles**

| Role | Used for | Starting values |
|---|---|---|
| Neutrals | Text, borders, backgrounds, past data | ink `#101828`, muted `#475467`, border `#E4E7EC`, page `#FFFFFF`, subtle `#F9FAFB` |
| Blue | The forecast line, primary buttons, links | `#1D4ED8` |
| Vermilion | Overdrawn (below $0), and only that | `#C2410C` |
| Amber | Below your minimum; dark text on an amber fill | fill `#FDB022`, text `#7A2E0E` |
| Teal | On track, used sparingly | `#0F766E` |

- Amounts stay near-black. Color goes on the marker or label next to an amount, never on the number itself.
- **Contrast:**
  - text: at least 4.5:1
  - hero numbers: about 7:1
  - chart marks and control borders: at least 3:1
- **Check every screen** in grayscale, and with Chrome DevTools → Rendering → Emulate vision deficiencies. Blue and vermilion stay distinct for red-green color blindness, and overdrawn also gets hatching.

**Layout**
- Light theme, 8px spacing grid, content up to 1440px wide.
- At most five cards visible without scrolling, and one main action per card *(judgment)*.
- Designed for the laptop first; it also has to work at phone width.

**Motion**
- Things move only when data changes: the chart crossfades in under 200 ms, and the previous line stays as a faint ghost.
- No counting-up numbers, animated gauges or parallax.
- Respect `prefers-reduced-motion`.

## Numbers and words

- **Amounts:** `$1,840` with no cents, unless cents matter (a fee or interest: `$13.54/month`). Use commas and a true minus sign (−, U+2212).
- **Flows:** sign every one: `+$2,000 Paycheck`, `−$1,200 Mortgage`.
- **Negative balances:** add a word, as in `−$300 overdrawn`.
- **Tables:** right-align amounts and use tabular figures.
- **Rounding:** sentences about the forecast can say "about $300." Tables show exact scheduled amounts.
- **Dates:** `Tue, Nov 10`. Say "today" or "tomorrow" only for those two days.
- **Plain names:** "Debt payments vs. income," not "DTI." "Card use," not "utilization."
- **Tone:** "Heads up," not "Warning." "Room to grow," not "Bad." Never blame.
- **One formatter:** keep a single shared formatter in `packages/shared` (money and dates), so the dashboard, texts and charts always agree.

## Screens

### 1. Home

From top to bottom:

1. **Status banner** (only when there's a problem): "Heads up: you'd be overdrawn by about $300 on Tue, Nov 10," with a **See 3 fixes** button.
   - Styling: a vermilion left border, an icon and the word "Overdrawn."
   - It stays until the problem is solved, then reads "Fixed: clear through Dec 7" for a day. No toasts that fade away.
2. **The pace line**, full width (section 2).
3. **Upcoming**, beside the chart on wide screens: the next 14 days of bills and paychecks.
   - Each row: date · name · account · signed amount. Rows are grouped into Upcoming and Done.
   - Clicking a row highlights its marker on the chart.
4. **Your accounts**, grouped the way PNC lists them (checking, savings, CDs and IRAs, loans, credit cards, mortgage).
   - Balances are right-aligned, with net worth on top.
   - Debts sit under a "You owe" heading as positive amounts, not negative numbers.
5. **Health**: four rows, not cards. Each row shows a plain name, the value, a bullet graph (a bar against a goal band in shades of one color), a status word and the next step:
   - "Emergency fund · 0.6 months · goal 3–6 · Room to grow · The CD move takes this to 1.5 months"
   - "Card use · 56% · goal under 30% · Room to grow"
   - "Debt payments vs. income · 35.5% · goal 36% or less · On track"
   - "Lowest balance in 30 days · −$300 on Tue · Overdrawn". This one is a factual alert, so it can use vermilion.

### 2. The pace line (the forecast chart)

- **A stepped line, not a smooth curve.** The checking balance changes on the days things post, and a smooth curve suggests money drains away gradually.
- **Axes:** $0 is the heaviest gridline and always visible. Never cut off the bottom of the y-axis.
- **Your minimum:** a dashed line labeled on the right: "Your minimum $100."
- **Below the minimum:** amber fill between the line and the minimum, labeled "Below your minimum."
- **Below $0:** vermilion with diagonal hatching, labeled "Overdrawn."
- **Markers:** paychecks get ▲ above the line ("+$2,000 Paycheck") and bills get ▼ below it ("−$1,200 Mortgage"). Label the 3–5 largest; the rest show on hover or keyboard focus.
- **Time:** a "Today" line, with the past 14 days in gray.
- **Headline above the chart** gives the lowest point:
  - before a fix: "Lowest: −$300 on Tue, Nov 10"
  - after one: "Lowest: $100 on Mon, Nov 9 · never below your minimum"
- **Scenarios** (what-ifs and offers being checked): the current line fades to a ghost, the new line is solid, and the headline shows the change: "Lowest −$300 → $100."
- **Uncertainty** (Could): a soft band with no border for "if a paycheck posts a day late," plus one sentence such as "Overdrawn in 1 of 3 likely timings." Our forecast uses scheduled items only, so this is optional.
- **Accessibility:**
  - The headline doubles as the chart's text summary.
  - Markers can be reached with the keyboard and have labels.
  - A "Show as table" toggle gives the same data as a table.

### 3. Fixes (option cards)

These open from the banner, and the iMessage text carries the same options. There are three cards side by side, each with:
- **A title:** "Move car payment to Fri, Nov 13"
- **The outcome:** "Lowest $100 · never below your minimum"
- **The cost:** "$0 if the lender waives the fee; you allow up to $25"
- **A trade-off line** when there is one: "Savings drops below your $1,500 floor"
- **One action:** "Call my lender," "Put it on my card" or "Move $400 from savings"

PacePay's recommendation gets a small "PacePay's pick" tag and a one-line reason ("No new debt, savings untouched"). Nothing is pre-selected; the person chooses.

### 4. What-if panel

Modeled on Apple Card's payment wheel: change one input and see the result instantly.
- **Inputs:** move a payment (date picker), pay a bill now (toggle), paycheck arrives late (0–3 day stepper), use the CD (amount), move money from savings (amount).
- **The result comes first:** "Lowest −$300 → $100," "Emergency fund 0.6 → 1.5 months." The chart with its ghost line sits below.
- **Buttons:** "Reset" and "Ask PacePay to do this."

### 5. Call view (the demo's centerpiece)

It opens automatically when a call starts. On the expo laptop it takes the right 40% of the screen.
- **Header:** "Calling your auto lender · 0:42," then "PacePay is an AI assistant calling for you," then an "End call" button (secondary).
- **Live transcript:** speakers labeled "Lender" and "PacePay (AI)," newest at the bottom, in large text.
- **Offer cards** stack up as offers come in:
  - "Wed, Nov 11 · no fee → **Doesn't work**: overdrawn about $300 on Wed," with a ✕ icon and the word.
  - "Fri, Nov 13 · $20 fee → **Works**: lowest $100 · within your $25 limit · waiting for your OK," with a ✓ icon and a status chip.
- **The pace line** shows the offer being checked as the solid line, with the current plan as a ghost.
- **What was shared:** "Shared with the lender: your name and loan reference. Not shared: balances, your limits."

### 6. Approve the deal

Modeled on GOV.UK's "Check your answers" pattern.
- **Title:** "Approve this change?"
- **Before → After table:**

  | | Before | After |
  |---|---|---|
  | Payment date | Tue, Nov 10 | Fri, Nov 13 |
  | Fee | none | $20 |
  | Lowest balance | −$300 | $100 |

- **A small before/after chart.**
- **Buttons:** **"Approve: move payment to Fri, Nov 13 ($20 fee)"** and an equally prominent **"Decline."** The button names the action, never just "OK."
- **After approval:** the status moves through Proposed → Approved → Confirmed by lender, with the reference number. "Cancel" stays available until the lender confirms.
- **The first approval** happens earlier, before any call. When the person picks "Call my lender," PacePay shows the limits it will work within: dates through Fri, Nov 13, fees up to $25, no new credit, valid for 48 hours. The person confirms those limits.

### 7. Activity

A log, newest first. Each entry has:
- **time**
- **who acted** (You / PacePay / Lender)
- **what happened**
- **why**, the trigger with its numbers
- **status**
- **evidence:** transcript, reference number, before/after

Also:
- Log declines and failures too: "The lender couldn't move the date · PacePay texted you two other options." Showing what didn't work keeps trust matched to what the agent can actually do.
- Mark AI-written summaries "AI summary," and link each one to its transcript.
- Clicking a chart marker opens its log entry *(judgment)*.

### 8. Your rules

- The settings: minimum balance, savings floor, the most you'll pay in fees, off-limits accounts, quiet hours, and who PacePay may call.
- A prominent **"Pause PacePay"** switch that stops all texts and calls.

### 9. Arena

- **A scorecard header in big numbers:** "0 limit violations · 0 disclosures · N of 50 deals reached," using the real run's numbers.
- **A grid of 50 tiles** (10 × 5): each shows the lender's persona and an icon plus a word (✓ Deal, – No deal, ✕ Violation). Click a tile to open its transcript.

### 10. Presenter mode

A toggle (keyboard shortcut `P`) for the expo:
- It hides navigation and secondary panels.
- It enlarges the headline, chart and call view by about 25%.
- It keeps only the banner, the pace line, and the call view or approval.

## iMessage

- **The alert**, one thread per problem:
  > Heads up: paying the $650 repair from checking puts you at −$300 on Tue, Nov 10 (mortgage Mon, car payment Tue, paycheck Thu).
  > 1. Move the car payment to Fri → lowest $100, fee $0–$25 (my pick)
  > 2. Put it on your card → about $14/month interest
  > 3. Move $400 from savings → savings below your $1,500 floor
  > Reply 1, 2 or 3.
- **The chart image:** 1080 × 1350, light background. It has the headline sentence and the next 14 days of the pace line with the dip labeled, and nothing else. It goes out just before the options text, rendered from engine data (`SPEC.md` §6).
- **Mid-call approval:** "The lender offers Fri, Nov 13 with a $20 fee. Your lowest balance would be $100. Reply YES to approve or NO to decline."
- **When it's done:** "Done: car payment moved to Fri, Nov 13 ($20 fee). Lowest balance $100. Ref #A1B2C3. Reply 'what did they say?' for the call summary."
- **Quiet hours** apply to everything except mid-call approvals.

## Don'ts

- Glass and blur effects, decorative gradients, neon on dark.
- Gauges, donuts, rings, smooth curves, cut-off axes.
- Red and green as the only signal.
- Counting-up numbers and decorative animation.
- "AI insights" with no numbers, chat-only flows, false precision, one combined "financial health score," shaming copy, repeated alerts.
- Overpromising, like "never overdraft again."

## Pitch note for PNC

PNC already offers **Low Cash Mode** (a balance threshold you set, plus extra time to fix a negative balance) and Virtual Wallet's calendar of paydays and bills. Pitch PacePay as the next step: every account, 60 days ahead, with an agent that fixes the problem. Don't use the name "Danger Days," which is a PNC trademark.

## Build notes

- **Components:** Tailwind and shadcn/ui (Card, Table, Badge, Tabs, Dialog or Sheet, Tooltip, Switch, Slider, Calendar).
- **The pace line:** build it with visx instead of Recharts: `@visx/shape` with `curveStepAfter`, `@visx/pattern` for the hatching, `@visx/annotation` for labels. That gives exact control over the minimum line, the hatching and the ghost line. Recharts is fine for small charts.
- **Tokens:** define the five color roles and the type sizes once, as CSS variables.
- **Before calling a screen done:**
  - a grayscale screenshot
  - color-blindness emulation
  - a six-foot read
  - a keyboard-only pass
  - reduced motion on

## Sources

- Charts and uncertainty:
  - Kim et al., captions and chart emphasis: https://hci.stanford.edu/publications/paper.php?id=429
  - Fernandes et al., uncertainty displays for decisions: https://idl.uw.edu/papers/uncertainty-bus
  - Correll et al., truncated y-axes: https://www.tableau.com/research/publications/truncating-y-axis-threat-or-menace
  - Cleveland & McGill, graphical perception: https://www.jstor.org/stable/2288400
  - Few, bullet graph spec: https://www.perceptualedge.com/articles/misc/Bullet_Graph_Design_Spec.pdf
- Color and accessibility:
  - UK Analysis Function, colors in charts: https://analysisfunction.civilservice.gov.uk/policy-store/data-visualisation-colours-in-charts/
  - WCAG 2.2: use of color https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html, contrast https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html, non-text contrast https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
  - Stripe, accessible color systems: https://stripe.com/blog/accessible-color-systems
- Alerts and behavior:
  - FCA, automatic overdraft alerts: https://www.fca.org.uk/publications/occasional-papers/occasional-paper-no-36-sending-out-sms-impact-automatically-enrolling-consumers-overdraft-alerts
  - Medina, reminders and overdraft fees: https://ideas.repec.org/a/oup/rfinst/v34y2021i5p2580-2607..html
  - Ancker et al., alert fatigue: https://bmcmedinformdecismak.biomedcentral.com/articles/10.1186/s12911-017-0430-8
  - CMU, the ostrich effect: https://www.cmu.edu/news/stories/archives/2015/december/ostrich-effect.html
- AI and trust:
  - Bansal et al., explanations and overreliance: https://arxiv.org/abs/2006.14779
  - CFPB, chatbots in banking: https://www.consumerfinance.gov/about-us/newsroom/cfpb-issue-spotlight-analyzes-artificial-intelligence-chatbots-in-banking/
  - Microsoft, guidelines for human-AI interaction: https://www.microsoft.com/en-us/research/project/guidelines-for-human-ai-interaction/
  - FTC, Cleo order: https://www.ftc.gov/node/87670
- Writing and patterns:
  - GOV.UK style guide: https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/style-guides/a-to-z-style-guide/
  - GOV.UK check answers: https://design-system.service.gov.uk/patterns/check-answers/
  - NN/g, numerals: https://www.nngroup.com/articles/web-writing-show-numbers-as-numerals/
  - NN/g, glassmorphism: https://www.nngroup.com/articles/glassmorphism/
- Benchmarks:
  - CFPB, credit use: https://www.consumerfinance.gov/ask-cfpb/how-do-i-get-and-keep-a-good-credit-score-en-318/
  - CFPB, debt-to-income: https://files.consumerfinance.gov/f/documents/cfpb_your-money-your-goals_debt_income_calc_tool_2018-11_ADA.pdf
- Products worth copying:
  - PNC Virtual Wallet: https://www.pnc.com/en/welcome/virtual-wallet.html
  - PNC Low Cash Mode: https://www.pnc.com/lowcashmode
  - Monzo, balance in Trends: https://monzo.com/blog/balance-in-trends
  - Apple Card: https://www.apple.com/newsroom/2019/03/introducing-apple-card-a-new-kind-of-credit-card-created-by-apple/
  - Monarch, recurring: https://help.monarch.com/hc/en-us/articles/4890751141908
