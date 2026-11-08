# Demo video storyboard (earlier draft)

> Superseded by [video-plan.md](video-plan.md). Kept for the dashboard clip list.


Source of the outline: `v2.md` › Video. Judges skim, so the first 20 seconds have to show the problem and the last 15 have to name the three tracks. The Devpost link currently points at a placeholder; replace it with the real upload (YouTube, public or unlisted, **not** private).

Two kinds of footage: **P** = real phone (you on your iPhone, Ram's laptop running the server), **D** = dashboard screen recording. Record P after Ram's voice fix lands. Record D now.

| # | Time | Footage | On screen | Voiceover (draft, read it out loud once and cut what you trip on) |
|---|---|---|---|---|
| 1 | 0:00 to 0:08 | P | The $650 repair quote in your hand, then the iMessage send | "The shop quotes $650. I just text PacePay the photo." |
| 2 | 0:08 to 0:25 | P then D | PacePay's reply, the chart image, the three options. Cut to **Home**: the pace line dips coral to −$300 on Tue | "It sees that paying today overdraws checking on Tuesday, before Thursday's paycheck. It texts three options and picks one." |
| 3 | 0:25 to 0:35 | P | You reply 1, then OK on the limits | "I pick: ask the lender to move the car payment. I set the limits first: $25 max in fees." |
| 4 | 0:35 to 1:15 | P (audio) + D | The call. Show the lender-side phone ringing, the live transcript on **Messages** or the call console. Beats: AI disclosure, Wednesday declined with no reason, Friday for $20 | "PacePay says it's an AI, calling with my permission. The lender offers Wednesday. That's still before payday, so it asks for Friday without telling them why. Friday, $20." |
| 5 | 1:15 to 1:30 | P | The phone buzzes mid-call: "Approve?" You reply YES. Done text lands | "Before it says yes out loud, it texts me the exact terms. Nothing final without my yes." |
| 6 | 1:30 to 1:50 | D | **Home** turns green left to right, cash cushion tile fills. Click the four health stats | "Code does all the math. The forecast updates: checking never drops below $100." |
| 7 | 1:50 to 2:05 | D | **What-if** panel, then **Skip to Wed, Nov 18**: the CD alert, compare renew vs pay off the card | "Later, unprompted: the CD matures. Paying off the card saves about $550 a year." |
| 8 | 2:05 to 2:20 | D | **Activity** tab: each step with its model chip (Nemotron Ultra, Super, Nano VL, Claude, code). Then **Arena** tab, click one transcript | "Every step shows which model did it. Nemotron plans and reads the bill. Code runs the call and the math. Claude double-checks. We tested it against [ARENA] simulated lenders." |
| 9 | 2:20 to 2:35 | P | Paycheck-late texts: PacePay flagged it on its own, you text "my paycheck is going to be late", options come back, call first | "It even watches for the paycheck Friday depends on." |
| 10 | 2:35 to 2:50 | D | `docs/architecture.png` on screen, then the logo | "PNC: one picture of your whole financial life. NVIDIA: Nemotron runs the workflow. Photon: real texts and real calls. PacePay." |

## Dashboard recordings to capture now (D)

Run `pnpm --filter @pacepay/dashboard dev` and open http://localhost:3000 in **demo mode** (no server needed). Window 1440 × 800, Light theme (Night as one cutaway if you want it). Record each as its own clip so they cut cleanly:

1. **Home, the dip and the fix:** idle pace line with the −$300 dip, step the case to Done, the forecast sweeping green.
2. **Health stats:** click each of the four stats to show reason and improve line.
3. **What-if:** toggle a purchase and the paycheck-late switch.
4. **CD alert:** Skip to Nov 18, open the renew vs pay-off comparison.
5. **Messages:** the phone with the thread.
6. **Activity:** scroll the flight recorder, hover a model chip.
7. **Arena:** the 50-tile field, then click a tile and open its transcript (record this after Ram's rerun so the numbers match).

Record at 60 fps with the macOS screenshot toolbar (Shift-Command-5), hide the Dock and bookmarks bar, and turn on Do Not Disturb.

## Not yet decided

- Whether the real phone clips (P) get a voiceover or keep the call audio under a short caption.
- The final count to say in beat 8, which waits for the Arena rerun.
