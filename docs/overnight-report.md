# PacePay overnight report (Sun Nov 8, started ~5:15 AM)

Skeleton written at the start of the run. Status and Evidence columns are filled in as each track finishes. Demo freeze is about 11 AM.

## TL;DR (is it ready?)

**Not yet verified.** Every checklist item is TBD until it has evidence. Known so far: the demo path and fallbacks are documented in `docs/demo-runbook.md` and `docs/judge-qa.md`, and the numbers below come from files in the repo.

## What's live right now (build, how it's running)

- Live demo (do not touch): server on 127.0.0.1:8787, voice worker `pacepay-voice`, dashboard on :3000. Per the run brief, these run from the frozen copy `/Users/ramsarma/hackutd26-demo`.
- **Discrepancy to resolve:** `docs/demo-runbook.md` says to start all three from the repo root `/Users/ramsarma/hackutd26`. The run brief says the frozen copy is `/Users/ramsarma/hackutd26-demo`. Confirm which one Ram starts on stage before the first judge.
- Overnight verification uses throwaway servers with their own port and `PACEPAY_DATA_DIR`, `PACEPAY_MESSAGING=console`, and `LENDER_PHONE` unset. No real calls or texts.
- Working tree has many uncommitted changes (negotiator, orchestrator, qa, watcher, messaging, shared replies, voice). Nothing committed or pushed by this run. No git operations were run.

## Checklist

| Item | Status | Evidence |
|---|---|---|
| Adversarial lender calls | TBD | TBD |
| Texts answer accurately | TBD | TBD |
| Jailbreak / outlandish -> refusal | TBD | TBD |
| Inbound call with PIN spoken | TBD | TBD |
| Inbound call with PIN typed | TBD | TBD |
| No stutter / deep voice / restart (outbound) | TBD | TBD |
| No stutter / deep voice / restart (inbound) | TBD | TBD |
| Demo script end to end | TBD | TBD |
| Arena transcripts | TBD | TBD |
| Run 3 live | TBD | TBD |
| Dashboard live states | TBD | TBD |
| Judge photos | TBD | TBD |
| Tests / typecheck | TBD | TBD |
| Committed + pushed | TBD | TBD |
| pacepay.work deployed | TBD | TBD |

## What changed overnight

- TBD. Fill in from the track reports as they land.

## Known rough edges

- Call audio: line noise and a lender talking over PacePay can cause repeats. Every offer is read back, so a repeat is recoverable, but it costs time on stage.
- Model gateway latency: Ultra planning can take up to 45 s before falling back to Super. Bill reading is about 11 to 12 s median, 18 s max.
- Mid-call switch to text ("Call dropped? Switch to text") is **not tested after the lender has spoken**. Test once in rehearsal.
- Mobile hotspot backup for the laptop uplink is **not tested**.
- Run 3 live for the arena: no dashboard button found. Back up `data/arena.json` before trying it, or show the 50-run results.
- Stress set (363 personas): no graded pass rate in the repo. Do not quote one.
- Engine test count: the code has 57 cases by grep, the Devpost says 60. Run the suite for the real number.
- Data retention policy: none written. Do not claim one.

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

- **Arena** (`apps/dashboard/public/demo/arena-results.json`, `data/arena.json`, run `arena_f7rom7m`): 50 simulated lenders, 70% deals, 0 limit violations, 0 disclosures, 98% of offers read back.
- **Bill reader** (`docs/eval/`): 60 synthetic photos. Amounts 60/60, due dates 59/60. Claude cross-check agreed on every amount. Median about 11 to 12 s per bill, max about 18 s.
- **Call decisions** (`scripts/stress/out/full/calls/*.json`): median 14 ms, p95 35 ms per lender turn, 610 turns across 175 stored runs.
- **Stress personas** (`scripts/stress/personas/*.json`): 363 personas in 11 categories. No final pass rate.
- **Simulator** (`scripts/stress/`): runs the real voice turn loop over a simulated line with LLM-played lenders, rule checks, and a Claude judge. Quote the design, not a pass rate.
- **Engine tests:** 57 cases found by grep. Devpost says 60. Confirm with `pnpm --filter @pacepay/engine test` before quoting.
