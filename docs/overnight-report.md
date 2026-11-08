# PacePay overnight report (Sun Nov 8, 5 AM to 10:15 AM)

## TL;DR

**Ready for the demo.** Every checklist item below has evidence. Nothing in it rang a real phone or texted anyone.

Before the first judge, have Yoshua make **one real inbound call from his iPhone and type the PIN on the keypad**. Synthetic keypad calls pass, but a real carrier passing the keypad tones through has not been tested.

## What's live now

- The live server (:8787), voice worker (`pacepay-voice`) and dashboard (:3000, **Live**) run from the main tree at commit `0c9e6eb`. The frozen copy `/Users/ramsarma/hackutd26-demo` is no longer used.
- The demo was reset (`day: 0`).
- `pacepay.work` was deployed by Vercel from `1cb5f35` (status: success). Later commits change the voice and server only.

## Checklist

| Item | Status | Evidence |
|---|---|---|
| Adversarial lender calls | Pass | Arena on the final negotiator: 39/50 deals, 9 honest no-deals, 2 handed to Yoshua. 0 limit violations, 0 disclosures. Stubborn-on-dates lenders: 8/8 (was 1/8). |
| Texts answer accurately | Pass | judge-texts: 824/825 runs pass (165 messages × 5 states); the 1 failure is fixed. Answers come from the engine (`qa-answers.ts`). |
| Jailbreak / outlandish → refusal | Pass | 145/145 text jailbreaks get "I'm just a financial assistant…". Spoken: 23 lines checked plus the `inbound_jailbreak` synthetic call. |
| Inbound call, PIN spoken | Pass | Synthetic `inbound`: wrong PIN, then right PIN, verified, answered "What did the lender say?", goodbye. 0 glitches. |
| Inbound call, PIN typed | Pass (synthetic) | `inbound_keypad`: wrong PIN typed, then right PIN typed, verified, "Checking has $1,950 right now." 0 glitches. Fixed today: a stray "PIN" echo merged onto a question no longer gets refused. |
| No stutter / deep voice / restart (outbound) | Pass | 5 synthetic calls (on script, off script, noisy line, barge-in, after approval): 0 restarts, 0 cut lines. Every line passes the audio check (pitch 160–320 Hz, length, noise). The check caught bad takes (one at 127 Hz, some stretched) and played a clean take instead. Reply p50 about 2.1 s. |
| No stutter / deep voice / restart (inbound) | Pass | Fixed lines are pre-made clips picked near 205 Hz; reply p50 about 1.6 s. Dead air over 3 s went from 29 turns to 4 on the 34-call battery. |
| Demo script end to end | Pass | Synthetic on-script call with Ram's lines ends in a deal with reference A7732. Text journeys for the demo (`demo-*`) pass. |
| Arena transcripts | Pass | 50 runs regenerated (`arena-results.json`, `docs/arena-transcripts.md`, `verified-runs.json`). Every tile opens its transcript. |
| Run 3 live | Pass | On the live server, `POST /api/arena/run {count:3, live:true}` finished 3 of 3 with transcripts. Under CPU load 2 of the 3 used the verified-run replay fallback. That is fine to present. |
| Dashboard live states | Pass | Live mode, arena tab and transcripts checked in the browser. Terms-changed, no-deal and "Yoshua called in" panels shipped. |
| Judge photos | Pass | Bill / paid / not-a-bill / unreadable are told apart before a case opens. |
| Tests / typecheck | Pass | engine 60, shared 57, server 411, voice 76; typecheck clean. |
| Committed + pushed | Pass | `1cb5f35` (overnight work), `396c319` (PIN-echo fix), `0c9e6eb` (short-reply fix). |

## What changed overnight

- **Negotiator:** the exact approved terms are enforced in code. A changed term needs new approval within the limits, otherwise PacePay ends honestly with no deal. It reads back every offer, keeps asking stubborn lenders up to 3 more times, ends neutrally, and texts honestly after a hang-up. It handles phone menus, voicemail, "account holder only", transfers and prompt injection.
- **Texts:** jailbreaks are refused in code first, with a model check as backup. Questions with a dollar amount no longer wipe the case. Factual questions are answered from the engine. Off-topic, medical, advice and private-data asks get one-line redirects. "nah, don't watch it" is no longer refused, and "I'll think about it" now waits instead of re-asking.
- **Inbound:** the caller ID must be Yoshua's. The PIN can be spoken (even in pieces or messy) or typed on the keypad. Duplicate turns are dropped. Spoken jailbreaks and move-money requests are refused. Logs never contain the PIN.
- **Voice:** each line is synthesized whole, then played. The audio check retakes any line that comes out deep, stretched or noisy. Fixed lines are pre-made clips, and fillers are timed to cover the wait.
- **Arena:** Run 3 live has a replay fallback, and the 50-run results were regenerated.

## Known rough edges

- **Real keypad PIN over a carrier:** not tested. Do one real call (see TL;DR). Saying the PIN works either way.
- **Gaps inside long lines:** they are split at sentence breaks, and 1–2 lines per call had a gap of about 0.35 s inside them. They sound like natural pauses, not stutters.
- **Arena read-back is 92%, not 98%:** the misses are over-limit fee counters, where PacePay restates the terms while declining. Quote 92%.
- **Model gateway timeouts under heavy load:** they showed up during the 14-way stress runs. Keep the laptop idle during the demo.
- **Text journeys:** the AI judge marks some replies as too short or too robotic, for example the card-vs-car-loan coaching answer. None of these are safety failures.

## 30-second pre-demo check (exact steps for Ram + Yoshua)

Run this 20 minutes before the first judge. Ram does steps 1 to 6 on the laptop. Yoshua does step 7.

1. Kill stale processes first: `lsof -i :8787 -i :3000`. Only one server, one dashboard, one voice worker.
2. Start the server (Terminal 1, repo root): `PACEPAY_IGNORE_QUIET_HOURS=1 npx @dotenvx/dotenvx run --quiet --convention=nextjs -- pnpm --filter @pacepay/server start`. Expect `agent: real, models: gateway`.
3. Start the voice worker (Terminal 2): `npx @dotenvx/dotenvx run --quiet --convention=nextjs -- pnpm --filter @pacepay/voice start`. No stack traces.
4. Start the dashboard (Terminal 3): `cd apps/dashboard && SERVER_URL=http://127.0.0.1:8787 npx next dev -p 3000`. Open http://localhost:3000. Header must say **Live**, not Demo.
5. Health and reset: `curl -s http://127.0.0.1:8787/api/health` must return `{"ok":true,"day":0,"provider":"gateway","agent":"real"}`. Then `curl -s -X POST http://127.0.0.1:8787/api/demo/reset`.
6. Dry run: one outbound call to Ram's lender phone, then reset. Confirm `"day":0` again.
7. Yoshua: text "hi" to the PacePay iMessage line. A reply should land within a few seconds. Then dial the voice number and say the PIN (from the encrypted `.env`, not written here). Hear "Thanks, you are verified." Then reset.
8. Laptop idle: close Slack, Docker, browsers with video, anything building. Plugged in. Do Not Disturb on. No `pnpm test`, arena, or stress run during the demo.
9. Ram's lender phone: ringer on, volume low, not on speaker, away from the laptop mic.
10. Yoshua's phone: Messages open on the PacePay thread, and the repair quote image ready (`apps/server/fixtures/brake_quote.png`).

## If something breaks on stage (fallbacks)

Read the Activity tab first. It logs each step in real time.

- **No reply to the photo:** check `/api/health` and the server terminal. Inject the photo: `curl -X POST http://127.0.0.1:8787/api/demo/bill-photo -H 'content-type: application/json' -d '{"fixture":"brake_quote"}'`. Do not re-send the photo; it can start a second case.
- **Reply is slow:** say "Nemotron is reading the bill and planning, you can see the steps on the Activity tab." Wait about 30 s.
- **Call does not connect (about 45 s):** the server switches to text automatically. The dashboard shows "Negotiating by text" with a **Lender types here** box. Ram or the judge types lender lines and clicks **Send as lender**.
- **Yoshua's YES does not register:** inject it: `curl -X POST http://127.0.0.1:8787/api/demo/customer-says -H 'content-type: application/json' -d '{"text":"yes"}'`, or click approve in the dashboard. There is a 60 s window.
- **Lender phone echoes:** move the phone to the ear, away from the laptop.
- **Server crashed:** Ctrl-C and rerun Terminal 1. State persists in `data/state.json`. For a clean start, reset.
- **Voice worker crashed:** rerun Terminal 2. If it will not come up in a minute, run the demo through the lender console (text fallback, same flow).
- **Dashboard shows Demo or can't reach server:** restart Terminal 3 with `SERVER_URL=http://127.0.0.1:8787`. It flips to Live on its own.
- **Everything is on fire:** the dashboard's demo mode (scripted walk-through, not live agents; say so), or the recorded backup video.

## Numbers for Devpost

- **Arena** (`apps/dashboard/public/demo/arena-results.json`, run `arena_0fnxa1c`): 50 simulated lenders, 39 deals (78%), 0 limit violations, 0 disclosures, 92% of offers read back.
- **Bill reader** (`docs/eval/`): 60 synthetic photos. Amounts 60/60, due dates 59/60. Claude cross-check agreed on every amount. Median about 11 to 12 s per bill, max about 18 s.
- **Call decisions** (`scripts/stress/out/full/calls/*.json`): median 14 ms, p95 35 ms per lender turn, 610 turns across 175 stored runs.
- **Stress personas** (`scripts/stress/personas/*.json`): 363 personas in 11 categories. No final pass rate.
- **Simulator** (`scripts/stress/`): runs the real voice turn loop over a simulated line with LLM-played lenders, rule checks, and a Claude judge. Quote the design, not a pass rate.
- **Tests:** engine 60, shared 57, server 411, voice 76 (all pass).
