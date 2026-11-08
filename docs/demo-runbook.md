# Demo runbook (Sun Nov 8, live from Ram's laptop)

Everything here was checked against the code on Nov 8 unless marked **[unverified]**. Nothing in this file was run end to end by the author; the commands come from `package.json`, `apps/server/src/index.ts`, `apps/server/src/api/demo.ts` and `apps/voice/src/agent.ts`.

## The one-paragraph version

Ram's laptop runs three things: the **server** (port 8787, the agent, negotiator and Photon bridge), the **voice worker** (LiveKit, makes and takes the phone calls) and the **dashboard** (port 3000). Yoshua texts the PacePay iMessage line from his iPhone. Ram holds the "lender" phone. Reset to day 0, run the script, and if anything breaks use the failure playbook at the bottom.

## Who does what

| Person | Device | Job |
|---|---|---|
| Yoshua | His iPhone (this is `CUSTOMER_PHONE`; the server only accepts texts and inbound calls from this number) | Texts the photo and the replies. Dials the PacePay voice number for the inbound demo. Narrates. |
| Ram | His own phone (this must be `LENDER_PHONE`, the number PacePay dials) | Plays the lender on the outbound call. Holds it to his ear, not on speaker. |
| Ram | Laptop | Runs server, voice worker, dashboard. Watches the Activity tab and the terminals. Does the reset. |
| Judge (optional) | Ram's lender phone | Can play the lender instead of Ram. Same lines work. |

Two numbers on one contact card (`design/brand/pacepay.vcf`): the iMessage line (texts) and the Photon voice number (calls). Yoshua texts the first and dials the second.

## 1. Start everything (three terminals, repo root `/Users/ramsarma/hackutd26`)

Check first: Ram's earlier session left a server (8787) and dashboard (3000) answering on this laptop. Kill old ones before starting so you do not run two (`lsof -i :8787 -i :3000`). Never run two voice workers: both register as `pacepay-voice` and one will take the call with stale code.

**Terminal 1, server**

```bash
cd /Users/ramsarma/hackutd26
PACEPAY_IGNORE_QUIET_HOURS=1 npx @dotenvx/dotenvx run --quiet --convention=nextjs -- pnpm --filter @pacepay/server start
```

- Expect `[server] PacePay server on http://127.0.0.1:8787 (agent: real, models: gateway)`. `agent: real` comes from the encrypted `PACEPAY_AGENT` in `.env` (decrypts to `real`). If it says `agent: stub` the scripted agent is running, which is wrong for the demo.
- `models: gateway` needs `TRUEFOUNDRY_API_KEY` from `.env.local`. If it says `nvidia`, that key did not load: no Claude, no Nano VL, no GPT TTS path.
- `PACEPAY_IGNORE_QUIET_HOURS=1` stops the proactive paycheck text and the CD alert from being held during quiet hours (`apps/server/src/messaging/outbox.ts`). Without it, those texts may silently not arrive and the Activity tab shows "Held a text (quiet hours)".
- The server binds to 127.0.0.1 only. Voice endpoints (`/api/voice/*`) refuse non-local callers (`apps/server/src/api/http.ts` `localOnly`).

**Terminal 2, voice worker**

```bash
cd /Users/ramsarma/hackutd26
npx @dotenvx/dotenvx run --quiet --convention=nextjs -- pnpm --filter @pacepay/voice start
```

- Needs `LIVEKIT_*` and `OPENAI_API_KEY` (the latter from `.env.local`). Agent name is `pacepay-voice`.
- It should log a LiveKit "registered worker" line **[unverified: that is the stock LiveKit Agents log; the exact text was not checked in this repo]**. Its own lines start `[voice]`.
- The worker has to be restarted after any change to `apps/voice/src`, and the server after any change to `apps/server/src`. Do not edit code after the freeze.

**Terminal 3, dashboard (live)**

```bash
cd /Users/ramsarma/hackutd26/apps/dashboard && SERVER_URL=http://127.0.0.1:8787 npx next dev -p 3000
```

- Open http://localhost:3000. The header chip says **Live** (green dot) when connected. If it says **Demo** (amber), the dashboard could not reach `/api/health` within 1.5 s and is running the self-contained mockup; it re-probes every 6 s and flips to Live on its own (`apps/dashboard/lib/data-source.ts`). `SERVER_URL` is baked in at start, so if you forgot it, restart this terminal.
- Window: 1440 x 800 on the projector, **Presenter** on (header button), Light theme.

## 2. Reset and health

```bash
curl -s http://127.0.0.1:8787/api/health
# {"ok":true,"day":0,"provider":"gateway","agent":"real"}   <- want exactly this

curl -s -X POST http://127.0.0.1:8787/api/demo/reset
# {"ok":true}
```

- Reset puts the demo clock back to day 0 (Sat Nov 7 in demo time; the dates in the texts like "Tue, Nov 10" are demo dates, not today's calendar) and clears the case. The dashboard Reset button does the same thing.
- Reset does **not** touch the voice worker or Photon. It does not unsend texts already on Yoshua's phone: clear or ignore the old thread, or Yoshua will reply to a stale text. **[unverified: whether an old option reply sent after a reset is ignored cleanly; avoid it.]**
- Reset between every take. Do it, then check `/api/health` shows `"day":0`.
- Other useful controls (all `POST`, local only; through the public tunnel they are blocked, view-only):
  - `/api/demo/clock` body `{"day":11}` jumps to Wed Nov 18 (this is the dashboard's "Skip to Wed, Nov 18"): fires the CD alert.
  - `/api/demo/bill-photo` body `{"fixture":"brake_quote"}` injects the repair quote as if Yoshua had texted it.
  - `/api/demo/customer-says` body `{"text":"1"}` injects a text from Yoshua.
  - `/api/demo/fail-call` forces the active call to fail and switches to text negotiation.

## 3. Pre-flight checklist (do it 20 minutes before the first judge)

- [ ] `npx @dotenvx/dotenvx run --convention=nextjs -- node scripts/check-keys.mjs` prints ok for every key (prints names and status only). `.env.keys` is in the repo root and `.env.local` has `TRUEFOUNDRY_API_KEY` and `OPENAI_API_KEY`.
- [ ] `/api/health` returns `ok:true`, `provider:"gateway"`, `agent:"real"`.
- [ ] Dashboard header says **Live**, not Demo.
- [ ] Voice worker terminal is up with no stack traces and shows it registered with LiveKit **[unverified exact text]**.
- [ ] Photon line up: send Yoshua's phone one text yourself via `curl -X POST http://127.0.0.1:8787/api/demo/customer-says -H 'content-type: application/json' -d '{"text":"hi"}'` and check the reply lands in the thread; or have Yoshua text "hi" to the PacePay iMessage line and watch the Messages tab. The server polls Photon every 2 s (`apps/server/src/messaging/photon.ts`), so a reply within a few seconds means the bridge is alive. A "Could not route a message" warn on the Activity tab means it is not.
- [ ] Dry run of the call: one full outbound call to Ram's lender phone, then **reset**.
- [ ] Inbound check: Yoshua dials the voice number from his phone, says "<the PIN>" (in the encrypted .env), hears "Thanks, you are verified." (PIN is `INBOUND_PIN`; the caller ID must be Yoshua's number or the PIN is rejected, `apps/server/src/api/voice.ts`). Then reset.
- [ ] Laptop idle: close Slack, Docker, browsers with video, anything running a build or a Vercel dev server. Plugged in. Do Not Disturb on. Do not run `pnpm test`, the arena or the stress harness during the demo (they hit the same model gateway).
- [ ] Wi-Fi: both phones and the laptop on stable connections. The call goes laptop -> LiveKit cloud -> SIP trunk -> the phone network, so the laptop's uplink matters. Tether or a second network is the backup **[unverified: not tested]**.
- [ ] Ram's lender phone: ringer on, not on speaker, volume low, no earbuds required but fine. Phone away from the laptop mic (the lender phone speaker near an open mic echoes into the line).
- [ ] Yoshua's iPhone: Messages open on the PacePay thread, notifications visible, the printed repair quote (`design/props/repair-quote.html`, rendered image `apps/server/fixtures/brake_quote.png` is the fixture) or a clear photo ready. Photo flat, bright, whole quote in frame.
- [ ] Backup video of the full flow recorded and on the laptop desktop (v2.md asks for one).
- [ ] Arena tab loads (50 runs, 70% deals, 0 limit violations, 0 disclosures, 98% read-back; the numbers in `apps/dashboard/public/demo/arena-results.json` and `data/arena.json`).

## 4. The demo script (about 3 minutes)

Pick the opening by who is judging (from `v2.md`): **PNC** start on the dashboard Home ("Yoshua's money is in eight places, here are four health scores and the next 60 days"); **NVIDIA** start on the Activity tab ("a photo, no question; Nemotron plans it and runs the plan"); **Photon** start on the phone ("PacePay lives in his contacts; watch it text first, then call").

### A. Outbound: the repair case

| # | Who | Action | What you should see |
|---|---|---|---|
| 1 | Yoshua | Texts the photo of the $650 Northside Auto repair quote, no caption | Quick ack ("Got it: $650 to Northside Auto Service, due today. Checking your week."), then in about 15 s a chart image and the three options. Dashboard Home shows −$300 on Tue in red. |
| 2 | Yoshua | Replies **1** (ask the lender to move the car payment) | Activity tab: terms lookup, plan, then a text asking OK on limits ("... $25 max in fees. OK?"). |
| 3 | Yoshua | Replies **Yes** (or "OK") | Second opinion (Claude) runs, "Calling your lender now", Ram's phone rings. |
| 4 | Ram | Answers, holds phone to ear. PacePay opens with the AI disclosure and the ask for Friday Nov 13. | Live transcript on the dashboard Call panel. |
| 5 | Ram | Plays the lender (below) | Wednesday is read back and declined without a reason; Friday with a fee over $25 gets pushed back; $20 passes. |
| 6 | Yoshua | His phone buzzes mid-call: "They'll move it to Fri, Nov 13 for $20. ... Approve?" He replies **Yes** within 60 s | PacePay confirms on the call and takes a reference number. |
| 7 | Ram | Hangs up after the goodbye | "Done. Car payment is now Fri, Nov 13 ($20). Ref ..." text. Forecast turns green, cash cushion tile green. |
| 8 | (unprompted) | Wait a few seconds | PacePay texts: "This works as long as your paycheck lands Thursday. I'll check Thursday night ... Reply NO to skip." |
| 9 | Yoshua | Replies **Ok** | Watch stays on. |
| 10 | Yoshua | Texts **My paycheck is going to be late, it lands Monday** | Recalculation (checking −$320 on Fri) and the options again with the call first. **The demo ends here, no second call.** |

Suggested lender lines for Ram (the negotiator handles variations; this is the path that exercises every gate, from `v2.md`):

1. After the greeting: "Sure, I can help. What do you need?" (it will already have asked)
2. "I can move it to Wednesday." -> PacePay reads it back and asks for Friday instead.
3. "Friday works, but there is a thirty-five dollar fee." -> PacePay asks to waive it or lower it.
4. "Okay, twenty dollars." -> PacePay reads back "Friday the 13th with a twenty-dollar fee?" Say **yes**. (Yoshua's phone buzzes now.)
5. While waiting for Yoshua, say nothing or "Take your time". If you want the 60 s timeout path, do not have Yoshua answer.
6. After the confirmation: "Your reference number is K, 7, Q, 2, M, 9." -> PacePay captures it, says goodbye, hangs up.

Judge-driven variants the code already handles (`apps/server/src/agent/negotiator.ts`, `situations.ts`): Thursday (payday, pushed to Friday), a big fee, "early next week" (asks which day), "I need to verify the account holder" (gets a reference, texts Yoshua), a flat no (thanks, ends, texts next-best options), IVR menus, voicemail, hold music.

### B. Inbound: Yoshua calls PacePay

Run after A (so there is a call to ask about), or after a reset if you only show this.

1. Yoshua dials the PacePay voice number from his own phone (caller ID must match `CUSTOMER_PHONE`).
2. PacePay: "Hi, this is PacePay, Yoshua's money assistant. For your security, please say your four-digit PIN."
3. Yoshua says **"<the PIN>" (in the encrypted .env)** (saying it digit by digit or as words also works; the spoken PIN is stored in the transcript as "(said the PIN)"). PacePay: "Thanks, you are verified. What would you like to know?"
4. Yoshua asks **"What did the lender say?"** -> a summary of the call, from the thread and the negotiation record.
5. Other questions the transcription prompt expects: "Can I afford a $900 bill?", "When's my next paycheck?", "How am I doing?". Hang up with "Okay, bye."
6. Wrong PIN three times -> "I could not verify the PIN, so I have to end the call." Before the PIN, no figures are spoken (`apps/server/src/agent/qa.ts`).

### C. Closers by judge

- **PNC:** header "Skip to Wed, Nov 18" (or `POST /api/demo/clock {"day":11}`): the CD alert arrives by text; compare renew vs pay off the card in the what-if panel.
- **NVIDIA:** Activity tab (each step has a model chip) and the Arena tab (50 simulated lenders, click a transcript). "Run three live" from v2.md: the server has `POST /api/arena/run` with body `{"count":3,"live":true}` (`apps/server/src/api/arena.ts`; progress streams to the dashboard over SSE). **[unverified]** I found no run button for it in the dashboard, did not run it, and did not check whether a 3-run result replaces the stored 50-run results on the Arena tab (the dashboard falls back to the shipped 50-run file only when the server has none). Rehearse it once and back up `data/arena.json` first, or skip it and show the 50.
- **Photon:** the paycheck-late thread, and the inbound call.

## 5. Failure playbook

**Know the fastest tell:** the Activity tab (dashboard) logs every step and warning in real time. Read it first.

| Symptom | Likely cause | What to do |
|---|---|---|
| No reply to Yoshua's photo | Photon poll stalled, server down, or the photo came from a different number than `CUSTOMER_PHONE` (ignored) | Check `/api/health`. Look at the server terminal. Fallback right now: `curl -X POST http://127.0.0.1:8787/api/demo/bill-photo -H 'content-type: application/json' -d '{"fixture":"brake_quote"}'` injects the same photo. The dashboard Messages tab mirrors the thread. |
| Reply text takes long | Model gateway slow (planner Ultra timeout is 45 s, then falls back to Super; bill reader eval measured about 11 to 12 s median on a photo, max 18 s) | Say: "Nemotron is reading the bill and planning, you can see the steps on the Activity tab." Do not re-send the photo (it can start a second case). Wait about 30 s. |
| Call does not connect (no ring after about 45 s) | SIP trunk or LiveKit or lender phone off; dispatch gives up at 45 s (`apps/server/src/voice/dispatch.ts`), the server then emits CALL_FAILED and switches to text negotiation automatically | Dashboard shows "Negotiating by text" with a **Lender types here** box (`apps/dashboard/components/panel/Call.tsx`). Ram (or the judge) types the lender's lines there and clicks **Send as lender**. Same negotiator, same gates, same approval text. Narrate: "If a call drops, PacePay falls back to text." |
| Call connects but goes wrong mid-call (noise, silence, wrong words) | Real phone line | Click **Call dropped? Switch to text** in the panel (`POST /api/demo/fail-call`) and continue by lender console from there. **[unverified: not tested mid-call after the lender has already spoken; test it once in rehearsal.]** |
| Lender phone echoes or PacePay hears itself | Lender phone on speaker near the laptop mic | Put it to the ear, move it away from the laptop. |
| Yoshua's YES does not register mid-call | Reply sent as a different text format, or Photon delay | Inject it: `curl -X POST http://127.0.0.1:8787/api/demo/customer-says -H 'content-type: application/json' -d '{"text":"yes"}'`. Or click approve in the dashboard Messages/Call panel. There is a 60 s window; after that PacePay asks the lender to hold, gets a reference and texts Yoshua, which is itself a good thing to show. |
| Slow model on the call | The decision is mostly code (stress runs: median 14 ms, p95 35 ms per decision); only an unreadable lender line goes to Super with a 2.5 s cap and a code fallback. Real latency on a live line is mostly speech-to-text and TTS (voice stress run, per-turn numbers in `scripts/stress/out/inbound-*.json`) | Say: "PacePay reads every offer back before it checks it, that is the pause." A short filler ("Mm-hm...") plays by itself after about 1.1 s. |
| Server crashed | | Ctrl-C and rerun the Terminal 1 command. State is persisted to `data/state.json` so the case may resume. If you want a clean start run `POST /api/demo/reset`. Restart the voice worker only if its terminal shows errors. |
| Voice worker crashed or not registered | | Rerun the Terminal 2 command. If it will not come up in a minute, run the whole demo with the lender console (the text fallback above is the same flow, no phone). |
| Dashboard shows "Demo" | Server unreachable or `SERVER_URL` missing | Check Terminal 3 was started with `SERVER_URL=http://127.0.0.1:8787`; restart it if not. It flips to Live by itself once `/api/health` answers. |
| Everything is on fire | | Last resort: the **demo mode** of the dashboard. `https://www.pacepay.work` opens in demo mode (no server connection, per the README), or http://localhost:3000 without `SERVER_URL`. Press **Ask my lender**, **Call now**, then step through the call; **Skip to Wed, Nov 18** shows the CD alert. This is a scripted walk-through of the same case, not live agents: say so. The recorded backup video is the other last resort. |
| pacepay.work does not show the live demo | The public site cannot reach localhost | Expected unless a tunnel (Tailscale Funnel) is up and `SERVER_URL` is set in the Vercel project **[unverified: whether this is currently configured]**. Demo from http://localhost:3000. Requests through a tunnel are view-only by design. |

### The dashboard's Presenter mode

Header button **Presenter** (`state.ui.presenter`): compacts the page and hides the status chips (`apps/dashboard/components/Header.tsx`). Use it on the projector. The moon icon toggles Night theme. It changes nothing about the agents.

## 6. Things not to say

From `v2.md` and `docs/devpost.md`: never "guarantees no overdrafts", "lenders always agree", or "replaces a financial advisor". The money is a seeded household, not a connected bank; no money moves anywhere, PacePay only changes a due date by asking a lender (a simulated or friendly one, played by a teammate).

## 7. Known mismatches to keep straight while presenting

- README and v2.md say GPT realtime "speaks" on calls. The code says otherwise: the realtime model only listens and transcribes (`create_response: false`, no tools); every spoken word is a line written by code and read with OpenAI TTS (`gpt-4o-mini-tts`, voice marin). See the `apps/voice/src/agent.ts` header. Say "GPT realtime hears, code decides the words, TTS speaks."
- The server uses Photon through its REST API (polling every 2 s), not the `spectrum-ts` SDK that v2.md names.
- The bill reader runs on `nvidia.nemotron-nano-12b-v2` (Nemotron Nano 2 VL) through the gateway. Plain Nano (`NEMOTRON_NANO_MODEL`) is configured but no job routes to it.
