# PacePay UI direction

How PacePay looks and behaves, based on usability research, accessibility standards and the best money apps (sources at the bottom). Lines marked *(judgment)* are design calls, not research findings. **For anything visual, this file overrides `v2.md` and `SPEC.md`.**

**Mockup:** [PacePay UI mockup](https://claude.ai/artifact/4AYWnV8XcT1oXqxo9tNyjG), a clickable dashboard and the iMessage thread. It's private until Ram shares it.

## The rules

1. **Say less.** Every item gets one short line. The main screen has no explanations; details are one click away.
2. **One thing at a time.** Home has one chart and one PacePay panel that walks through the current step: heads-up, then fix, call, approve and done. Each step replaces the last instead of stacking up.
3. **Lead with the answer.** The first thing anyone reads is the outcome ("−$300 on Tue, Nov 10"), and the chart's most visible feature matches it.
4. **Numbers, not adjectives.** Show the amount, the date and the cost.
5. **Never rely on color alone.** Every state also gets a word or a shape.
6. **Don't judge.** Health stats show the goal next to the number ("Goal: under 30%"), and "On track" once it's met. No grades, no red, no single combined score.
7. **Alert only when it matters**, meaning the forecast crosses your minimum or $0. Use one thread per problem.
8. **The person decides,** twice: first the limits before PacePay calls, then the final deal.
9. **Show evidence, not reasoning.** Show before/after numbers, not the model's explanation.
10. **Calm and still.** Light theme on warm neutrals, one typeface, three accent colors, no decorative motion.
11. **Look made, not generated.** Skip the template defaults: a grid of cards, pill badges, KPI tiles with progress bars, Inter on slate gray, dark navy with neon accents.

## Look and feel

**Type**
- One family, IBM Plex Sans (fallback: system UI), in weights 400, 500 and 600. Use tabular figures (`font-variant-numeric: tabular-nums`) for every amount. Big numbers use 500, not bold.
- **Sizes:**
  - balance: 40px
  - panel headline: 26px
  - health stat values: 26px
  - body: 16px
  - labels: 14px
  - chart labels: 13px

  **Presenter mode** scales everything up 25% for the expo.

**Theme: light, warm, few boxes** *(judgment)*
- The page is a warm light gray (`#F2F1ED`), not white. Only the PacePay panel is white, so the one thing that needs you stands out.
- The balance, chart and health stats sit right on the page. Space and hairlines (`#E0DED7`) separate them, not cards.
- No pills, chips or badges. A status is a short line of text, with a small swatch that matches the chart.
- Tabs and the range switch are plain text, underlined when selected. Presenter and Reset are plain text buttons.
- One soft shadow, on the PacePay panel only.

**Color: three accents on warm neutrals**

| Role | Used for | Values |
|---|---|---|
| Neutrals | Page, panel, text, lines | page `#F2F1ED`, panel `#FFFFFF`, text `#1C1B19`, muted `#64615A`, hairline `#E0DED7`, $0 line and bill markers `#7A766D`, "Before" line `#8F8A80` |
| Green (brand) | The forecast line, primary buttons, the selected tab, paychecks, "Works" and "On track" | `#1C6B4A`, tint `#E6F0EA` |
| Vermilion | Overdrawn (below $0), and only that | text and low dot `#B83A0B`, hatching `#C2410C` on `#FBE8DF` |
| Ochre | Your limits: the minimum line, "Your limits" and "Over limit" | line `#A36A00`, text `#8A5A00` |

- Amounts stay near-black. Color goes on the marker or label next to an amount, never on the number itself.
- **Contrast:** 4.5:1 or more for text, 3:1 or more for chart marks and control borders. Measured on the page color: body text 15:1, muted text 5.5:1, green 5.7:1, vermilion 5.1:1, ochre text 5.2:1, $0 and minimum lines 4.0:1, "Before" line 3.0:1. White text on green buttons: 6.5:1.
- **Check every screen** in grayscale, and with Chrome DevTools' color-blindness emulation.

**Layout: open, not boxed**
- Page padding is 28–32px, and 40px separates the left side from the PacePay panel.
- Home fits one laptop screen (1440 × 800) without scrolling.
- Never leave big empty areas.
- At phone width the PacePay panel drops below the chart.

**Motion**
- Things move only when data changes: the chart crossfades in under 200 ms, and the previous line stays as a faint dashed ghost.
- No counting-up numbers. Respect `prefers-reduced-motion`.

## Numbers and words

- **Amounts:** `$1,840` with no cents unless they matter. Use a true minus sign (−) and sign every flow: `+$2,000`, `−$1,200`.
- **Chart labels** use short names: "+$2,000 Pay," "−$1,200 Mortgage," "−$400 Car." Axis labels use `$2k`.
- **Dates:** `Tue, Nov 10`. Say "today" and "tomorrow" only for those two days.
- **Plain names:** "Debt vs. income," not "DTI." "Card use," not "utilization."
- **Tone:** "Heads up," not "Warning." Never blame.
- **One formatter:** keep a single shared money and date formatter in `packages/shared`, so the dashboard, texts and charts always agree.

## Screens

**Navigation:** a slim header with the logo, three text tabs underlined when selected (**Home · Accounts · Activity**), Presenter, Reset and an avatar.

### Home

- **Left, straight on the page:** the checking balance ($1,950), one status line ("Lowest −$300 on Tue, Nov 10") and a range switch (Next 14 / 30 / 60 days, 14 by default) above the pace line.
  - **Under the chart, four health stats in a row,** split by hairlines. Each is a label, a value and one line:
    - Emergency fund · 0.6 mo · Goal: 3–6 months
    - Card use · 56% · Goal: under 30%
    - Debt vs. income · 35.5% · On track: under 36%
    - Net worth · $60,650 · 8 accounts
- **Right: the PacePay panel,** the only white card. One step at a time:
  1. **Heads up:** "−$300 on Tue, Nov 10 / If you pay the $650 repair today." Below that, the best fix on its own ("Move your car payment to Fri / Stays above $100. Fee up to $25.") with one button, **Ask my lender**. The other two fixes are plain rows under "Other options":
     - Put it on your card · About $14/mo interest
     - Use $400 of savings · Below your $1,500 floor
  2. **Limits** (first approval): "PacePay will call your lender," then three rows (New date: Fri, Nov 13 or earlier · Fee: $25 max · New credit: None) and one line: "It says it's an AI and never shares your balances." Buttons: **Call now** and **Cancel**.
  3. **Call:** "On the call with your lender" plus a timer.
     - The transcript shows its last 4 lines, each under a "PacePay" or "Lender" label.
     - Each offer gets a row with a one-word verdict: "Wed, Nov 11 · no fee · Overdrawn," "Fri, Nov 13 · $35 fee · Over limit," "Fri, Nov 13 · $20 fee · Works."
     - Meanwhile, the chart shows the offer being checked.
  4. **Approve** (second approval): "Approve this deal?" with three before → after rows (Payment Tue, Nov 10 → Fri, Nov 13 · Fee $0 → $20 · Lowest −$300 → $100). **Approve** and **Decline** are side by side, the same size.
  5. **Done:** "Covered through Dec 7," the results with the lender's reference number, and a **What happened** button that opens Activity.

### The pace line (the chart)

- **A stepped line.** Balances change on posting days, so they're never drawn as a smooth curve.
- **Reference lines:** $0 is the heaviest gridline and always visible. Your minimum is a dashed ochre line.
- **Shading:** hatched vermilion below $0, and nothing else.
- **Markers:** ▲ paychecks in green and ▼ bills in gray. Label only the first paycheck, the mortgage and the car payment, and only where the label covers no line; a label that fits nowhere is dropped. The rest show on hover or focus.
- **The lowest point** gets a dot. The status line states it, so the chart doesn't repeat it in text.
- **Scenarios:** the old line stays as a gray dashed "Before" line.
- **Axis labels** sit on the right, so the chart's left edge lines up with the balance above it.
- **Accessibility:** the status line is also the chart's text label, and Accounts → Next 14 days gives the same data as a list.

### What-if

A **What if** button next to the chart switches the PacePay panel to a few controls: move a payment, paycheck late, use the CD. The result shows first ("Lowest −$300 → $100"), and the chart updates with the ghost line. *(Not in the mockup yet.)*

### Accounts tab

Two lists side by side, straight on the page:
- **Accounts:** one line each (name · type · amount), with net worth in the header.
- **Next 14 days:** bills and paychecks (date · name · signed amount), with a moved payment on a green tint.

### Activity tab

One line per entry: time · who · what · status. For example: "7:04 PM · PacePay turned down Wed (overdrawn) and a $35 fee · Declined." Declines and failures get logged too.

### Rules, Arena, Presenter mode

- **Rules:** minimum balance, savings floor, the most you'll pay in fees, off-limits accounts, quiet hours, and **Pause PacePay**.
- **Arena:** a scorecard ("0 violations · 0 disclosures · N of 50 deals"), plus a 10 × 5 grid of tiles, each with an icon and one word.
- **Presenter mode:** everything 25% bigger. For the expo.

## iMessage

Keep every message short. These are the exact templates:

- *Alert:* "Heads up: −$300 on Tue, Nov 10 if you pay the repair today. 1. Move car payment to Fri (best) 2. Put it on your card 3. Use savings. Reply 1, 2 or 3."
- *Limits:* "I'll ask for Fri or earlier, $25 max fee. OK?"
- *Calling:* "Calling your lender now."
- *Approval:* "They'll move it to Fri, Nov 13 for $20. You stay above $100. Approve? YES or NO"
- *Done:* "Done. Car payment is now Fri, Nov 13 ($20). Ref A1B2C3."
- *Chart image:* 1080 × 1350 on the dashboard's warm gray, with one line ("Lowest: −$300 on Tue, Nov 10") and the next 14 days of the pace line: the $0 line, hatching below $0 and a dot on the lowest day. It's rendered from engine data and goes out just before the alert.

Quiet hours apply to everything except mid-call approvals.

## Don'ts

- Walls of text, explanatory sentences on the main screen, more cards than the step needs, big empty areas.
- Glass and blur effects, decorative gradients, accent stripes on the edges of cards.
- Template looks: a grid of cards, pill badges, KPI tiles with progress bars, Inter on slate gray, dark navy with neon accents, big white surfaces.
- Gauges, donuts, smooth curves, cut-off axes, red and green as the only signal.
- Counting-up numbers, decorative animation, repeated alerts.
- "AI insights" with no numbers, one combined "health score," shaming copy, overpromising.

## Pitch note for PNC

PNC already offers **Low Cash Mode** (a balance threshold you set, plus extra time to fix a negative balance) and Virtual Wallet's calendar. Pitch PacePay as the next step: every account, 60 days ahead, with an agent that fixes the problem. Don't use the name "Danger Days," which is a PNC trademark.

## Build notes

- **Components:** Tailwind and shadcn/ui: Card (for the PacePay panel only), Tabs (restyled as underlined text), Button, Tooltip, Switch and Slider. No Badge.
- **The pace line:** visx (`@visx/shape` with `curveStepAfter`, `@visx/pattern` for the hatching, `@visx/annotation`). Use Recharts only for small charts.
- **Tokens:** define the color roles and the sizes once, as CSS variables, and point shadcn's tokens (`--background`, `--card`, `--primary`, `--muted-foreground`, `--border`) at the values above. Load IBM Plex Sans with `next/font/google`.
- **Before calling a screen done:** a grayscale screenshot, color-blindness emulation, a keyboard-only pass, reduced motion on, and a check at phone width.

## Sources

- Charts and uncertainty:
  - Kim et al., captions and chart emphasis: https://hci.stanford.edu/publications/paper.php?id=429
  - Fernandes et al., uncertainty displays: https://idl.uw.edu/papers/uncertainty-bus
  - Correll et al., truncated y-axes: https://www.tableau.com/research/publications/truncating-y-axis-threat-or-menace
  - Cleveland & McGill, graphical perception: https://www.jstor.org/stable/2288400
  - Few, bullet graphs: https://www.perceptualedge.com/articles/misc/Bullet_Graph_Design_Spec.pdf
- Color and accessibility:
  - UK Analysis Function, colors in charts: https://analysisfunction.civilservice.gov.uk/policy-store/data-visualisation-colours-in-charts/
  - WCAG 2.2: use of color https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html, contrast https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html, non-text contrast https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
  - Stripe, accessible color systems: https://stripe.com/blog/accessible-color-systems- Alerts and behavior:
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
