# Judge Q&A

Forty likely questions in four groups (PNC, NVIDIA, Photon, general), ten each. Every answer is grounded in a file in this repo, cited in brackets. **[unverified]** marks a claim I could not confirm in the repo and that should not be said with confidence until someone checks it. Written Nov 8 from the working tree; where the README, v2.md or the Devpost draft disagree with the code, the code wins and the mismatch is called out.

Numbers you can quote, with their source:

| Fact | Value | Source |
|---|---|---|
| Arena | 50 simulated lenders, 70% deals, 0 limit violations, 0 disclosures, 98% of offers read back | `apps/dashboard/public/demo/arena-results.json`, `data/arena.json` (same run `arena_f7rom7m`) |
| Bill reader, 60 photos | Amounts 60/60, due dates 59/60 (30 AI-drawn: 30 and 29; 30 code-drawn: 30 and 30). Claude cross-check agreed on every amount. PacePay would have asked Yoshua to confirm 1 time in 60 | `docs/eval/bill-reader-*.json` (recounted from the files) |
| Stress personas | 363 adversarial call personas in 11 categories | `scripts/stress/personas/*.json` |
| Call decision time | Median 14 ms, p95 35 ms per lender turn (610 turns in 175 stored stress runs) | `scripts/stress/out/full/calls/*.json` |
| Engine tests | 57 test cases found by grep in `packages/engine/test`; the Devpost says 60 | **[unverified: run `pnpm --filter @pacepay/engine test` for the real count]** |

---

## PNC: 360° Financial Health Navigator

**1. Can PacePay move my money?**
No. There is no tool that moves money (the tool list is `get_accounts`, `get_forecast`, `simulate`, `check_offer`, `get_terms`, `read_bill`, `second_opinion`, `send_message`, `send_chart`, `request_approval`, `place_call`, `decide`, `post_call_summary`, `schedule_followup`; `packages/shared/src/tools.ts`). The only thing PacePay does is ask a lender to change a due date and record the result in the forecast. The accounts are a seeded demo household, not a connected bank.

**2. What stops it agreeing to something bad?**
A state machine, not a prompt. A call cannot start without Yoshua's own pick of the call option and his OK on the limits; a deal cannot be confirmed without his approval; a hold is only requested if the approval timed out [`apps/server/src/agent/machine.ts`, `GUARDS`]. Every offer goes through the engine's `check_offer` [`apps/server/src/tools/check_offer.ts`], and a read-back of the lender's terms comes first.

**3. What if the lender changes the terms after Yoshua said yes?**
The approval is voided. PacePay restates the approved terms and asks the lender to honor them; if they insist on new terms still within limits, Yoshua gets a fresh approval; over limits or a walk-back ends the call with "nothing was agreed" and the Done text is not sent [`apps/server/src/agent/negotiator.ts`, "The safety contract"]. Covered by `apps/server/test/negotiator.test.ts` and `negotiator-stress.test.ts`.

**4. What if Yoshua doesn't answer the approval?**
60 seconds, then PacePay asks the lender to hold the offer, gets a reference number, ends the call and texts Yoshua [`DEAL_APPROVAL_TIMEOUT_MS` in `packages/shared/src/constants.ts`; `HOLD_REQUESTED` guard in `machine.ts`].

**5. Does it disclose that it's an AI? What about recording?**
Yes, on every call it opens by saying it is an AI assistant acting with Yoshua's permission and that the call is transcribed [`apps/server/src/agent/negotiator.ts`, lines about "AI assistant ... transcribed"]. In the arena the grader counts disclosures and the stress grader has deterministic rules for it (`scripts/stress/grade.mts`, `AI_DISCLOSE`, `HUMAN_CLAIM`). If a lender asks "are you a bot" it answers truthfully (`ASKED_AI` rule). That is a good-faith design, not legal advice: I did not verify call-recording consent law by state, or whether any rules on automated calls to lenders apply **[unverified; do not claim compliance]**.

**6. What does the lender learn about Yoshua's finances?**
Nothing financial. The voice worker's brief is an allowlist: direction, greeting, goal, name, account reference, counterparty name [`VoiceBriefResponse` in `packages/shared/src/api.ts`; `apps/server/src/api/voice.ts`]. PacePay never states balances, the checking floor, the fee limit or a reason, and "info probes", scam questions and prompt injection from the lender are handled by code-written replies [`apps/server/src/agent/situations.ts`]. The arena measured 0 disclosures in 50 runs; the stress set tests this much harder.

**7. What happens to data? Who sees the balances?**
The data lives in `data/state.json` on the presenter's laptop. The money numbers are computed in code. But the planner, orchestrator and Q&A models do receive household facts in prompts (Nemotron through the TrueFoundry gateway and build.nvidia.com; Claude for the second opinion), and bill photos go to the vision model. The claim we make is narrower and true: the *voice* path never sees balances, and the lender never does. We have not built a data-retention or deletion policy **[unverified: no such code or doc found]**.

**8. Inbound calls: how is Yoshua's account protected?**
Two checks: the caller ID must equal Yoshua's number, and he must say the PIN (3 tries, then hang-up). Before the PIN, the Q&A path refuses figures (any digit in a reply is replaced by a canned refusal). The spoken PIN is stored in the transcript as "(said the PIN)" [`apps/server/src/api/voice.ts`; `apps/server/src/agent/qa.ts`]. Honest limits: caller ID can be spoofed and a 4-digit PIN is weak; a real product would add a second factor. The demo PIN should be treated as burned since this repo is public.

**9. What does "health" mean here, and is it advice?**
Four scores computed by the engine: cash cushion (lowest checking in 30 days vs floor), emergency fund (months), credit use, debt-to-income, each with a goal, a reason and how to improve [`packages/engine`, `v2.md` dashboard table]. It is a forecast tool on a sample household; PacePay never claims to guarantee no overdraft or replace an advisor (`v2.md`, "Claims to avoid"). Options include a stated pick and the trade-off of each; Yoshua chooses.

**10. Would it work on real accounts?**
Not today. Real accounts need Plaid (a stretch goal in `v2.md`, not built), and, importantly, verification that an agreed change actually shows up on the account, which we don't do: after a deal the forecast is updated from the agreed terms, not from a bank feed [`docs/devpost.md` "What's next"]. Also the lender in the demo is a teammate on a phone.

---

## NVIDIA: Use Nemotron Beyond a Chatbot

**11. Which Nemotron model does what?**
From the code, not just the docs [`apps/server/src/models/gateway.ts`, `.env`]:

| Job | Model |
|---|---|
| Planner (the step plan for each event, call plan, CD advice) | Nemotron 3 Ultra, `nvidia/nemotron-3-ultra-550b-a55b`, on build.nvidia.com; retry falls back to Super |
| Orchestrator (runs the plan with tools, ranks options, wording of texts) and Q&A | Nemotron 3 Super 120B, `nvidia.nemotron-super-3-120b` via AWS Bedrock on the gateway |
| Call decisions (`decide`) | Super, but see Q13: code reads most lender turns first |
| Bill photos | Nemotron Nano 2 VL, `nvidia.nemotron-nano-12b-v2` |
| Simulated lenders in the arena | Ultra (falls back to Super) [`apps/server/src/agent/arena.ts`, `lenderSays`] |

**12. Where does Nano (the plain one) fit?**
It doesn't, in production. `NEMOTRON_NANO_MODEL` (`nemotron-nano-3-30b`) is configured but no job routes to it [`gateway.ts` `routes()`]. We tried Nano for call decisions and it skipped the tool call in testing, so Super took the seat (`docs/devpost.md`, "What we learned"). I could not find that test's output in the repo, so treat the numbers behind it as **[unverified]**. The Nano in "Nano 2 VL" is the vision model.

**13. Is Nemotron really making the decisions on the call, or is it code?**
Mostly code, deliberately, and say so. `decide` reads the lender's words in code first (yes/no, day, fee, repeats, questions) in a few milliseconds; only lines code can't read go to Super, capped at 2.5 s with a code fallback [`apps/server/src/agent/negotiator.ts` header]. Nemotron does plan every event (Ultra), run each plan and word each text (Super, with facts-checked output), read each bill (Nano 2 VL), answer free-text questions (Super with read-only tools) and play every arena lender (Ultra). The honest framing for "beyond a chatbot": Nemotron plans and acts; code enforces the gates and does all math. This evolved after `v2.md` (which has Super deciding every response) because live calls need under a second.

**14. How accurate is the bill reading?**
60 generated bill photos with known answers (30 drawn by an AI image model, 30 drawn by code, with angles, crumpling, low light, thermal receipts): amounts right 60/60, due dates 59/60 [`docs/eval/`]. The one miss: a "due at pickup" receipt with no printed date, read as due today. Claude's cross-check agreed on all 60 amounts, and PacePay would have asked Yoshua to confirm once. Caveats: the photos are synthetic, 30 distinct bills drawn two ways, not real phone photos from the wild. Speed: the harness times show median about 11 to 12 s and max about 18 s per bill (probably including the Claude cross-check **[unverified what `ms` covers]**), so the instant reply is an acknowledgement, not the answer.

**15. What does Ultra buy you, and what if it's down?**
Ultra is the planner because planning is the hardest reasoning in the flow. A plan is validated by code (known step kinds, models, order); one retry carries the errors; after that the event's template plan is used and logged as a warning [`apps/server/src/agent/planner.ts`]. The gateway client falls back from Ultra to Super on timeout (45 s) [`models/index.ts` `DEFAULT_TIMEOUTS`]. Ultra needs `NVIDIA_API_KEY`; without it Super plans. NVIDIA-only mode (`models/nvidia.ts`) runs everything on build.nvidia.com but cannot do Claude, images or TTS.

**16. Where are the multi-agent, RAG, ReAct, multimodal and eval patterns?**
Multi-agent: planner (Ultra), orchestrator and negotiator (Super), bill reader (Nano 2 VL), simulated lenders (Ultra), reviewer and grader (Claude). Agentic RAG: the planner decides if it needs a loan's fine print and `get_terms` embeds and looks it up [`apps/server/src/tools/get_terms.ts`] (embedding model is EMBED_MODEL via the gateway, not NVIDIA's, unless `NVIDIA_EMBED_MODEL` is used). ReAct: `decide` → `check_offer` → reply. Multimodal: bill photos. Eval: the arena.

**17. Why Claude in an NVIDIA project?**
Different model family as a reviewer and grader, so Nemotron never grades Nemotron: Claude reviews the call plan before dialing (30 s timeout; if it is unavailable, the plan proceeds with a warning) [`apps/server/src/agent/secondOpinion.ts`], cross-checks the bill amount and due date, and grades arena transcripts. It decides nothing. Be upfront that the arena lender is also Nemotron, so the negotiator and the lender share a family: that is a weakness of the benchmark, not a hidden advantage.

**18. What does the arena actually show?**
50 text-mode negotiations against simulated lenders in personas such as cooperative, fee-pusher, stubborn on dates, vague, flat refusal, identity check [`apps/server/src/agent/arena.ts`, `ARENA_PERSONA_MIX`]: 70% reached a deal (the rest are flat refusals and identity checks that end without one by design), 0 limit violations, 0 balance or limit disclosures, 98% of offers read back, graded by Claude. Limits: it is text, not voice; the lenders are LLM-written; the grader is an LLM; it does not test phone-line noise (that is the stress harness). Transcripts: `docs/arena-transcripts.md`.

**19. What is the stress simulator?**
`scripts/stress/` runs 363 adversarial lender and caller personas (11 categories: ASR chaos, authorization, customer text, happy path, hostile, IVR/voicemail, offers, policy, social engineering, terms, transfer/hold) through the real voice turn loop (`apps/voice/src/conductor.ts`) over a simulated line, with LLM-played lenders and deterministic transcription noise, then grades with rule checks (AI disclosure, no balance disclosure, no false agreement) plus a Claude judge (`scripts/stress/grade.mts`). **I found 175 stored run results (`scripts/stress/out/full/`) but no graded report in the repo, so do not quote a pass rate unless Ram has one.** It never touches the live server.

**20. What did Nemotron's tool calling cost you?**
Latency is the main trade-off, handled with code-first reading, a 4 s default `decide` timeout (2.5 s cap on calls), prewarmed TTS for likely lines and a filler only if a lookup is still running after about 1.1 s [`apps/voice/src/conductor.ts`, `speech.ts`]. Free-text answers by Super with tools are slower (seconds). The honest weak spot is Ultra planning: it is the slowest step (up to 45 s timeout).

---

## Photon: messaging agent on Photon 2.0

**21. Is it really on iMessage, and really phone calls?**
Yes to both on Ram's laptop. Texts: iMessage line through Photon's API; the server polls for new messages from Yoshua's number every 2 s and sends text, chart images and attachments [`apps/server/src/messaging/photon.ts`]. Calls: LiveKit with SIP on a Photon voice number, outbound to the lender and inbound from Yoshua [`apps/server/src/voice/dispatch.ts`, `apps/voice/src/agent.ts`]. The Devpost says the full photo-to-Done loop was still to be confirmed on a phone run **[unverified until the rehearsal passes]**.

**22. Did you use Spectrum (`spectrum-ts`)?**
No. `v2.md` plans it, but the adapter is raw REST against `https://api.photon.codes/v1` with a User-Agent, bearer key, idempotency keys, polling and multipart attachment upload [`photon.ts` header]. Say "Photon 2.0 REST", not "Spectrum".

**23. How does the inbound voice call work, and what is the PIN for?**
Yoshua dials the Photon voice number; the worker reads the SIP caller ID, calls `/api/voice/inbound`, PacePay asks for a four-digit PIN, and only after that does it answer questions ("What did the lender say?", "How am I doing?") with figures [`apps/server/src/api/voice.ts`, `apps/voice/src/conductor.ts` `InboundConductor`]. An API-level battery of PIN variants (spoken digits, punctuation, wrong PINs, wrong caller ID) ran green in `scripts/stress/out/inbound-api-*.json`; I checked the file's first cases only **[unverified: full results]**. Phone-audio inbound testing exists (`inbound.mts voice`) but I have no result file for it.

**24. Who's actually talking on the call? Is that GPT realtime?**
Hear and speak are split. OpenAI's realtime model (`gpt-realtime-2.1`) only listens: voice activity detection and transcription, with `create_response: false` and no tools. Every spoken word is a line written by code (the negotiator's `say`) and spoken with OpenAI TTS (`gpt-4o-mini-tts`, voice marin). If TTS fails, the realtime model reads the exact line [`apps/voice/src/agent.ts` and `speech.ts` headers]. README and `v2.md` still describe GPT realtime as "the voice"; the code is stricter. This is a point in favor of the safety story: no model can improvise on a call.

**25. How is the human kept in the loop?**
Three approvals: choose the option, OK the limits before the call, approve the exact terms mid-call by text; the lender waits on hold while the text goes out [`apps/server/src/agent/machine.ts`, `request_approval`]. The reply parser accepts short answers ("1", "yes", "ok") and tolerates late or stray replies [`apps/server/src/messaging/classify.ts`, `packages/shared/src/replies.ts`].

**26. What is "delightful default" here? Does it spam?**
Unprompted texts (CD alert, shortfall alert, reminders, the paycheck watch) are held during quiet hours or when Yoshua pauses PacePay, and the watcher fires each alert once [`apps/server/src/messaging/outbox.ts`, `apps/server/src/agent/watcher.ts`]. The demo disables the quiet-hours check with `PACEPAY_IGNORE_QUIET_HOURS=1`.

**27. Context across time and channels?**
The call summary lands in the same thread; "what did they say?" works by text and by phone; the late-paycheck watch persists, and "My paycheck is going to be late, it lands Monday" re-runs the forecast and re-offers the options [`apps/server/src/messaging/router.ts`, `packages/shared/src/replies.ts` `isPaycheckNews`]. State survives a restart via `data/state.json` (not tested here **[unverified]**). Household mode (a partner gets summaries) is *not* built.

**28. What happens if the call fails?**
Dispatch gives up after 45 s without an answer; the server marks the call failed and the negotiation continues over text with the same negotiator and gates; the dashboard shows a lender console for it, and a "Call dropped? Switch to text" button forces it mid-call [`apps/server/src/voice/dispatch.ts`, `apps/server/src/api/demo.ts`, `apps/dashboard/components/panel/Call.tsx`]. IVR menus (send keypad tones), voicemail, hold music, wrong number and transfers are handled in `situations.ts`.

**29. Is the call noisy or slow in practice?**
First real call had line noise read as replies and an early hang-up; both were fixed (ignore noise, wait for the goodbye to finish, 450 ms end-of-turn on server VAD) [`docs/devpost.md` Challenges; `apps/voice/src/agent.ts` comments with measured settings]. Per-turn latency on the live line is dominated by transcription and TTS, not the decision. I have no single clean end-to-end number to quote; do not quote one **[unverified]**.

**30. How would this scale beyond a laptop?**
It doesn't claim to. One process holds all state in memory with a JSON snapshot, events are handled one at a time, and one worker per call; Postgres and an always-on host (Brev) are in the plan, not the code **[unverified: `DATABASE_URL` exists in env, no usage found in the server code reviewed]**. The public site is view-only through a tunnel by design.

---

## General

**31. What's real and what's simulated?**
Real: iMessage texts, PNG chart rendering from engine data, bill photo reading, outbound phone call to a real phone, inbound call with PIN, model calls, the engine, the gates. Simulated: the household (eight seeded accounts, no bank link), the lender (a teammate or judge on a phone; or an LLM in the arena), the dates (demo clock, day 0 is Sat Nov 7 and can jump), and the deal's effect (it updates PacePay's forecast, nothing at a bank changes).

**32. Where do the numbers come from? Do models do math?**
No model computes a number. The engine (`packages/engine`) produces balances, scores, what-ifs and offer checks; texts are built from a facts object and Super's wording is facts-checked (regenerate once, then the template) [`apps/server/src/agent/orchestrator.ts` header]. Q&A must trace every $ or % to a tool result or the context block, else regenerate once, then a canned text [`apps/server/src/agent/qa.ts` header]. Photos and call audio are the only places a model reads numbers in, and PacePay confirms them.

**33. What's the latency a judge will feel?**
Ack to the photo: immediate. Chart and options: about 15 s per `v2.md` (planner plus orchestrator; I did not measure it in this pass **[unverified]**). Call: the lender's turn to PacePay's reply is dominated by speech-to-text plus TTS; decisions themselves are 14 ms median in the stress harness. Read-backs add deliberate pauses.

**34. What breaks?**
Honestly: a noisy line or heavy accent can corrupt a transcribed number, which is why every offer is read back and a hedged answer ("something like that") gets the exact terms read back again. A lender who talks over PacePay can cause repeats. The model gateway or Ultra can be slow or down (fallbacks: Ultra to Super, then template plans and canned texts). The bill reader can misread a bill with no printed date (1 of 60). Photon polling is 2 s. One laptop is a single point of failure, so there is a lender console, a demo mode and a backup video.

**35. What did you cut or not build?**
Plaid sandbox, household mode, Spanish, fine-tuned Nano, calling Yoshua when a payment will bounce within hours (all in `v2.md` "Could"). Patching Yoshua into a call that needs identity verification is also not built (PacePay gets a reference and texts him instead).

**36. How did you test it?**
Unit tests for the engine (57 cases found), shared templates and replies, the server's contracts, negotiator and router (`apps/server/test`, ~90 cases found by grep), voice conductor and inbound tests (`apps/voice/test`), the 50-run arena, 60 bill photos, a 363-persona stress set (partial results only) and an inbound PIN battery. A lot of that is new and uncommitted at the time of writing (working tree shows modified files and new `situations.ts`, `scripts/stress/`, `apps/voice/test/`) **[unverified that all tests currently pass]**.

**37. What's the business angle? Who pays?**
Not built into the repo. The plausible answer: a consumer subscription or a bank/fintech partnership, and lenders benefit from fewer missed payments. Do not state numbers. The demo's claim is narrow: timing mismatches cause overdrafts and fees, and lenders do move due dates [`docs/devpost.md`].

**38. How do you keep the keys safe in a public repo?**
Secrets are encrypted in `.env` with dotenvx; the decryption key `.env.keys` is gitignored; TrueFoundry and OpenAI keys are only in `.env.local` on Ram's machine; `npx @dotenvx/dotenvx protect` blocks a commit with a plaintext secret [`README.md` Setup]. Do not paste any key on screen.

**39. What was the hardest problem?**
Two conversations at once: the lender stays on the line while Yoshua reads and answers the terms, so the negotiator needs holds, a 60 s window, a deal that can be voided if terms change, and lines that never repeat word for word (`negotiator.ts`, `conductor.ts`). A close second: the model must never be the one to say a number on the phone, which is why every line is code-written [`docs/devpost.md` Challenges].

**40. If you had one more day?**
Connect Plaid sandbox and verify the changed payment against the account; run the stress set to completion and publish the graded report; replace the 4-digit PIN with a stronger second factor; run the arena with a non-Nemotron lender to remove the same-family bias; measure end-to-end call latency and put one honest number in the Devpost.

---

## Claims the docs make that the code or repo does not back up (fix before judging)

1. README and `v2.md`: "GPT realtime speaks on calls". Code: realtime listens only, TTS speaks code-written lines (Q24).
2. `v2.md`: `spectrum-ts`. Code: REST (Q22).
3. `v2.md`: "Super decides every response". Code: code reads first, Super is a capped fallback (Q13).
4. README's "Nano" mention: plain Nano is not routed (Q12). The Devpost "Nano skipped the tool call" test has no output in the repo.
5. Devpost `[ARENA]` placeholders: the numbers now exist in `arena-results.json` (50 runs, 70% deals, 0 violations, 0 disclosures, 98% read-back). The Devpost says "Nemotron 3 Ultra played each lender", consistent with `arena.ts`.
6. Devpost "60 unit tests": grep finds 57 test cases in the engine tests (Q36); run the suite and use the real number.
7. `v2.md` "run three live" arena: no dashboard button found (see `docs/demo-runbook.md` section 4C).
8. `v2.md` says the bill reader read a phone number in 0.9 s; the 60-photo eval timings are about 11 to 12 s median per bill. Quote the eval, not the 0.9 s.
