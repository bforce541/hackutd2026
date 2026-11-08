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
8. **The person decides,** twice: an OK on the limits before PacePay calls, then an OK on the deal, even mid-call.
9. **Show evidence, not reasoning.** Show before/after numbers, not the model's explanation.
10. **Calm, and motion only when it explains.** A warm light theme (plus Night), two typefaces, and the spectrum as the one color idea. Nothing moves for decoration; every animation shows a change (a number moved, a plan changed, a step advanced). All of it is off for people who ask for reduced motion.
11. **Look made, not generated.** Skip the template defaults: a grid of cards, pill badges, KPI tiles with progress bars, Inter on slate gray, dark navy with neon accents.

## Design v2 (Nov 7): what changed and why

The first version was correct but plain. This pass keeps every behavior and rebuilds the look around one idea: **the logo is the interface.** The logo's five translucent tiles (coral, orange, amber, lime, leaf) become the chart, the case stepper and the health meters. The spectrum only ever means "how safe is this."

- **The pace line is a field of day tiles.** Each day is a translucent tile standing on the $0 line: leaf when safe, amber near your minimum, coral hanging below $0 (and hatched, so color is never the only cue). Hover or arrow-key along it to read any day; a callout names what causes the dip ("Mortgage + Car payment").
- **The agent card's top is five tiles,** one per step (Heads up, Limits, Call, Approve, Done). They light up coral to leaf as the case advances; the full spectrum means done.
- **Health stats have five-tile meters** instead of numbers alone: one tile is far from the goal, five means it is met. No gauges, no grades.
- **Two themes on one token set.** Light is the default; Night is one click (the moon in the header).
- **Motion, only where it explains:** the balance counts up on load; tiles rise in a wave; tiles glide and re-color when the plan changes (a deal landing turns the dip green, left to right); steps ease in; the lowest point pulses twice; the plan's checks draw themselves. Curves: `--ease-out` (expo-out) for things that arrive or morph, a gentle ease for color.
- **View only.** Through the public tunnel the server answers reads only (`/api/health` says `readOnly`). The header then says "View only", Skip and Reset disappear, every control that changes something is dimmed and inert (`.pp-write`), and the panel says actions run on the presenter's laptop. Reading, tabs and What-if keep working, so anyone on pacepay.work can watch the live demo.
- **Messages is a phone** showing the iMessage thread, with tappable questions. **Activity** is a flight recorder: every step and log row carries the model that did it. **Accounts** is net worth plus six category cards. **Arena** is a field of 50 tiles.

Source of truth for the values is `apps/dashboard/app/globals.css`; where this section and the older text below disagree, this section wins.

## Look and feel

**Type**
- Two families: **Instrument Sans** (display and UI, weights 400, 500 and 600, the same as the wordmark) and **DM Mono** (the small uppercase labels above sections). Use tabular figures (`font-variant-numeric: tabular-nums`) for every amount. Big numbers use 500 with tight tracking (−0.045em), not bold. Loaded with `next/font/google`.
- **Sizes:**
  - balance: 64px
  - panel headline: 30px
  - health stat values: 28px
  - micro labels (DM Mono, uppercase, 0.08em): 11px
  - body: 16px
  - labels: 14px
  - chart labels: 13px

**Theme: light, warm, few boxes** *(judgment)*
- The page is a warm light gray (`#F2F1ED`), not white. Only the PacePay panel is white, so the one thing that needs you stands out.
- The balance, chart and health stats sit right on the page. Space and hairlines (`#E0DED7`) separate them, not cards.
- No pills, chips or badges. A status is a short line of text, with a small swatch that matches the chart.
- Tabs and the range switch are plain text, underlined when selected. Reset is a plain text button.
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

**Navigation:** a slim header. On the left, the logo and five text tabs, underlined when selected (**Home · Messages · Activity · Accounts · Arena**). On the right, the demo controls: today's date with a **Skip to Wed, Nov 18** button, Reset and the avatar. Rules live on the Accounts tab.

**Demo controls:** the Skip button jumps the demo clock to day 11 (Wed, Nov 18), which is when the CD alert arrives. On day 11 it reads **Back to Sat, Nov 7**.

### Home

- **Left, straight on the page:** the checking balance ($1,950), one status line ("Lowest −$300 on Tue, Nov 10") and, above the pace line, a **What if** button and a range switch (Next 14 / 30 / 60 days, 14 by default). What if sits left of the range switch and is hidden during a call.
  - **Under the chart, four health stats in a row,** split by hairlines. Each is a label, a value and one line, and each is a button. Clicking one shows one line under the row with why and how to improve; clicking again closes it.
    - Emergency fund · 0.6 mo · Goal: 3–6 months. Opens: "Savings ($1,800) cover 0.6 months of essentials ($3,065 a month). The CD on Nov 20 could take it to 1.5 months."
    - Card use · 56% · Goal: under 30%. Opens: "$2,800 of your $5,000 limit. Under $1,500 gets you below 30%."
    - Debt vs. income · 35.5% · On track: under 36%. Opens: "$1,835 a month in debt payments on $5,167 a month of income."
    - Net worth · $60,650 · 8 accounts. Opens: "$207,950 in assets minus $147,300 owed."
- **Right: the PacePay panel,** the only white card. One step at a time:
  1. **Heads up:** "−$300 on Tue, Nov 10 / If you pay the $650 repair today." Below that, the best fix on its own ("Move your car payment to Fri / Stays above $100. Fee up to $25.") with one button, **Ask my lender**. The other two fixes are plain rows under "Other options":
     - Put it on your card · About $14/mo interest
     - Use $400 of savings · Below your $1,500 floor
  2. **Limits** (first approval): eyebrow "Your limits" in ochre, then "PacePay will call your lender," then three rows (Ask for: Fri, Nov 13 · Most in fees: $25 · New credit: None) and one line: "It says it's an AI and never shares your balances." Buttons: **Call now** and **Cancel**.
  3. **Call:** "On the call with your lender" plus a timer.
     - The transcript shows its last 4 lines, each under a "PacePay" or "Lender" label.
     - Each offer gets a row with a one-word verdict: "Wed, Nov 11 · no fee · Overdrawn," "Fri, Nov 13 · $35 fee · Over limit," "Fri, Nov 13 · $20 fee · Works."
     - Meanwhile, the chart shows the offer being checked.
     - **Text fallback:** if the call fails ("Call dropped? Switch to text" in the mockup), the header becomes "Negotiating by text" with an ochre dot and the note "The call dropped. Same negotiator, same limits." A "Lender types here" box appears above the buttons. Same transcript, offer checks and approvals.
  4. **Approve** (second approval): "Approve this deal?" with three before → after rows (Payment Tue, Nov 10 → Fri, Nov 13 · Fee $0 → $20 · Lowest −$300 → $100). **Approve** and **Decline** are side by side, the same size.
  5. **Done:** "Covered through Dec 7," the results with the lender's reference number, and a **What happened** button that opens Activity.
- **Two more states use the same panel:**
  - **What-if:** opened by the What if button (see What-if below).
  - **CD alert:** appears when the demo clock reaches day 11. Eyebrow "Coming up," headline "Your $5,000 CD matures Fri, Nov 20." Then a green "Best use" eyebrow, "Pay off your card, save the rest" and "$2,214 to the card, $2,786 to savings. Saves about $550 a year, and your emergency fund goes from 0.6 to 1.5 months." Buttons: **Compare in what-if** (opens the what-if panel with the CD row checked) and **Later**. One other-option row: "Renew the CD · Earns about $205 a year." Footer: "You make the move at your bank. PacePay never moves money."

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

The **What if** button turns the PacePay panel into the what-if panel. It runs the engine in the browser, so it updates as you click.

- **Top:** eyebrow "What if" and a **Close** button.
- **Result first:** "Lowest in the next 14 days," then "−$300 → $100" (now → what if), then "Days below $0: 2 → 0."
- **Extra lines, only when relevant:** "Card use: 56% → 69%, about $14/mo interest" and "Emergency fund: 0.6 → 1.5 months, about $550 a year saved."
- **Checkbox rows:**
  - Move the car payment to Fri · Fri, Nov 13 with a $20 fee
  - Paycheck lands Mon, not Thu · Mon, Nov 16 instead of Thu, Nov 12
  - Put the repair on your card · About $14/mo interest
  - Use the CD to pay off your card · When it matures Fri, Nov 20
- **Footer:** "Nothing changes until you say so."
- **Chart:** it draws the what-if line, and the current plan stays as a gray dashed "Current plan" line.

### Messages tab

The iMessage thread, mirrored in dashboard style, in a centered column (640px max). PacePay's messages are in white boxes on the left, Yoshua's in a green tint on the right, and chart images show inline. The header note says "Same thread as iMessage." A **Message PacePay** input sits at the bottom. Anything typed there is treated exactly like a text from Yoshua (`POST /api/thread`). This is the dashboard's coach chat.

### Activity tab

Two columns.

- **Plan:** "The $650 repair · plan written by Nemotron 3 Ultra." The label shows whichever model actually wrote the plan (Nemotron 3 Super if the NVIDIA key is missing). Below it, a checklist with one row per step: a status mark (a filled check = done, a dot in a ring plus "In progress," an empty circle = waiting), the step title, and under it who runs it. The repair plan has 15 steps:
  1. Read the repair quote (Nemotron Nano 2 VL)
  2. Check the week if paid today (Engine)
  3. Compare card, savings and moving a payment (Engine)
  4. Text Yoshua the options and a chart (Nemotron 3 Super)
  5. Wait for Yoshua's pick (Yoshua)
  6. Pull the auto loan's terms (Nemotron 3 Super)
  7. Plan the call (Nemotron 3 Ultra)
  8. Check the limits with Yoshua (Yoshua)
  9. Second opinion on the call plan (Claude Opus 5.5)
  10. Call the lender (Code)
  11. Negotiate the due date (Nemotron 3 Super)
  12. Get Yoshua's OK on the deal (Yoshua)
  13. Text Yoshua the summary (Nemotron 3 Super)
  14. Update the forecast (Engine)
  15. Remind Yoshua the night before (Code)
- **Log:** newest first, one row each: time · who (a model, Engine, Code or Yoshua) · what. For example: "7:05 PM · Engine · Checked "Fri, Nov 13 · $35 fee": fails, over your fee limit." Declines and failures get logged too.

### Accounts tab

Two columns, straight on the page.

- **Left:** accounts grouped under PNC's six categories with small headings (Checking · Savings · CDs and IRAs · Loans · Credit cards · Mortgage, with the home's estimated value). Net worth is in the header. One line per account: name · detail · amount.
- **Right:** "Next 14 days" (date · name · signed amount, with a moved payment on a green tint), then "Your rules":
  - Keep in checking · $100
  - Keep in savings · $1,500
  - Most in fees · $25
  - Off-limits · Roth IRA
  - Quiet hours · 9 PM to 8 AM
  - A **Pause PacePay** switch

### Arena tab

- **Title and line:** "Negotiation arena" and "50 simulated lenders played by Nemotron, graded by Claude."
- **Stat row,** split by hairlines: Runs · Deals · Honest no deal · Handed to Yoshua · Limit violations · Disclosures.
- **Grid:** 10 × 5, one tile per run. Each tile has the persona word (Friendly, Fees, Firm, Vague, No, ID check, Chatty) and an outcome mark:
  - a check on a green tint = deal within limits
  - a dash on white = honest no deal
  - an arrow on an ochre tint = handed to Yoshua for an ID check
- **Below the grid:** a legend and a **Run 3 live** button.
- The mockup's numbers are samples, and the tab says so.

## iMessage

Keep every message short. These are the exact texts:

- *Ack after a bill photo:* "Got it: $650 to Northside Auto Service, due today. Checking your week."
- *Alert* (sent right after the chart image):
  > Heads up: −$300 on Tue, Nov 10 if you pay the repair today (mortgage Mon, car payment Tue, paycheck Thu).
  > 1. I ask your lender to move the car payment to Fri. My pick: no new debt
  > 2. Put it on your card: about $14/mo interest
  > 3. Use $400 of savings: drops below your $1,500 floor
  > Reply 1, 2 or 3.
- *Limits:* "I'll ask to move it to Fri, Nov 13, with $25 max in fees. OK?"
- *Calling:* "Calling your lender now."
- *Mid-call approval:* "They'll move it to Fri, Nov 13 for $20. You stay above $100. Approve? YES or NO"
- *Done:* "Done. Car payment is now Fri, Nov 13 ($20). Ref A1B2C3."
- *Reminder, the night before* (from `schedule_followup`; Thu, Nov 12, 8:00 PM): "Reminder: your $400 car payment and the $20 fee come out tomorrow. Checking will still have $1,680 after."
- *CD alert* (Wed, Nov 18, day 11, unprompted):
  > Your $5,000 CD matures Fri, Nov 20.
  > 1. Pay off your card ($2,214) and put $2,786 in savings. My pick: saves about $550 a year, and your emergency fund goes from 0.6 to 1.5 months
  > 2. Renew it: earns about $205 a year
  > Reply 1 or 2 and I'll send the steps.
- *CD reply after "1":* "Got it. I'll text you the steps Friday morning, when the CD matures."
- *Bill check, only when unsure:* "Is it $650 to Northside Auto Service, due today? YES or NO"
- *Chart image:* a 1200 × 800 PNG drawn like the mockup's chart card: warm gray background (#F2F1ED), the title "Lowest: −$300 on Tue, Nov 10," the subtitle "Checking, next 14 days," the stepped line in green (#1C6B4A), the $0 line (#7A766D), hatching below $0 (#C2410C lines on #FBE8DF), a vermilion dot (#B83A0B) on the lowest day, and date labels underneath (Today, Tue, Thu, Nov 20). IBM Plex Sans: bundle the TTF and pass it to resvg. It's rendered from engine data, never generated.

Option 1 is always PacePay's pick. The reply "n" means the nth option as texted.

The ack restates the merchant, amount and due date, and any reply that isn't a correction confirms it. PacePay asks the bill check outright only when Nemotron Nano 2 VL and the Claude cross-check disagree on the amount or due date, or the read's confidence is below 0.8. A reply with a dollar amount while the bill is unconfirmed ("it's $700") corrects the bill and re-runs the case.

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
