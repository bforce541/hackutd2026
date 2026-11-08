# PacePay demo video: director's plan

Supersedes `video-storyboard.md`. **Hard cap: 2:00.** Plan for **1:55** so there's a few seconds of slack. 16:9, 1080p.

> **This is a starting point, not a spec.** Whoever edits it is free to change anything: the order, the timing, the graphics, the transitions, the voiceover wording, the music, even the structure, if it makes a better video. The only things that have to hold are in "Must hold" below.

## Must hold

- **2:00 or less. This is the hard limit.**
- The real phone call is the centerpiece.
- The dashboard is shown, and the Nemotron model labels are visible somewhere.
- Everything on screen is real (real texts, real call, real dashboard) and every number matches the product.
- No keys, PINs or personal numbers readable on screen.

## Changes in this version (editor's cut, Nov 8)

- **Cold open** on 4 seconds of real call audio, then the hook. The call is the hero, so it opens the video.
- **The call gets 40 seconds** (was 32). The raw call is about 2 minutes; the parts we need come to about 36 seconds after jump cuts.
- **CD alert dropped** from the PNC beat to pay for the call time.
- **Lender script follows the runbook path:** Wednesday, then Friday with a $35 fee, then $20. The $25 fee limit is shown actually stopping an offer.
- **Offer checker is three rows**, all of which happen on the call. The Thursday row is gone.
- **The PIN is muted** in the inbound call and captioned "(says PIN)". The digits are not written anywhere in this doc.
- **Waits are trimmed** in the text exchange so replies appear right away. No elapsed-time chips.
- **Call audio comes from a second phone** recording Ram's speakerphone (iPhone screen recording mutes phone calls). That audio is laid over a call UI built for the video, captioned from the real transcript.
- **Arena numbers are final:** 50 runs, 0 limit violations, 0 balance leaks, 98% read-back, 70% deals.
- **Filming waits for the final voice fix.** Ram's Claude confirms the server and voice worker are restarted on it before the first take.

## The idea in one line

Lead with one moment a judge feels in two seconds ("a $650 bill, payday's Thursday, you'd overdraw"), let the **phone call** be the hero, then zoom out fast so each track sees its own criteria on screen: PNC (the whole picture, the what-if), NVIDIA (Nemotron doing the work, labeled), Photon (texts and calls, in and out).

Suggestions that tend to work at this length:
- One idea every 5 to 8 seconds. Cut anything that needs more.
- Show it working before explaining it.
- Captions burned in, so it works on mute. Music low, never over the call audio.

## Beat sheet (1:55)

| # | Time | What we see | Who it's for |
|---|---|---|---|
| 0 | 0:00 to 0:04 | **Cold open.** Call audio only, captions on a plain background: the lender says "I can do Wednesday", PacePay asks for Friday instead. | everyone |
| 1 | 0:04 to 0:10 | **Hook.** Yoshua with the printed quote and his iPhone. Text on screen: "$650 due. Payday is Thursday." Cut to the red dip, −$300 Tuesday. | everyone |
| 2 | 0:10 to 0:20 | **The photo.** He photographs the quote and texts it with no question. iPhone screen recording, waits trimmed: reply, chart, three options, he taps "1". | Photon, NVIDIA |
| 3 | 0:20 to 1:00 | **The call (hero).** Limits OK, PacePay dials. Jump cuts at each lender turn: Wednesday refused, Friday $35 pushed back, Friday $20 read back. His phone buzzes, he types YES on camera, PacePay confirms and takes the reference. | Photon voice, NVIDIA |
| 4 | 1:00 to 1:06 | **Done.** The text lands, the phone screen pushes into the dashboard, the red dip sweeps green. | everyone |
| 5 | 1:06 to 1:22 | **The whole picture (PNC).** Four health scores. Try a purchase: type $900, the line redraws. | PNC |
| 6 | 1:22 to 1:38 | **Nemotron at work (NVIDIA).** Activity tab with a model label on every step, the Arena grid, a quick (about 4s) architecture build. | NVIDIA |
| 7 | 1:38 to 1:49 | **The call back in (Photon).** On-screen text "It takes calls too". He dials PacePay, PIN muted, asks "What did the lender say?" and the real answer plays: date, fee, reference. No voiceover. | Photon voice |
| 8 | 1:49 to 1:55 | **Close.** Logo, tagline, three track tags, pacepay.work and GitHub. | everyone |

## Voiceover script (Yoshua's own voice, calm and casual)

The call audio carries beats 0, 3 and 7. Read it out loud once against a stopwatch and trim anything that runs long.

**1. Hook (6s)**
"A six hundred fifty dollar repair, payday's Thursday, and my bills land first. So I built PacePay."

**2. The photo (10s)**
"I text it a photo of the quote. It checks my week: pay today and I'm overdrawn Tuesday. Three options. I pick: ask my lender to move the car payment."

**3. The call (40s, short lines between call audio)**
"It checks my limits with me first: twenty-five dollars max in fees. Then it calls."
*(call audio: the lender offers Wednesday)*
"Wednesday's before payday, so the code says no."
*(call audio: Friday, thirty-five dollar fee)*
"Over my fee limit, so it pushes back."
*(call audio: twenty dollars, read back)*
"My phone buzzes. Nothing's final without my yes."

**4. Done (6s)**
"Done. Friday, twenty dollars. And the forecast turns green."

**5. The whole picture (16s)**
"Eight accounts, four health scores, sixty days ahead. Type any purchase: nine hundred overdraws checking."

**6. NVIDIA (16s)**
"Nemotron plans, reads the bill and decides every reply on the call, and every step is labeled. Claude double-checks, code does the math, GPT only speaks. Fifty simulated lenders: zero limits broken, zero balances leaked."

**7. Photon (11s)**
No voiceover. The real inbound audio plays, with the PIN muted.

**8. Close (6s)**
"PacePay. See what's left. Buy time if you need it."

## What's on screen during the call (beat 3)

A call UI built for the video, laid over the real call audio:
- The live transcript as captions, lender lines in grey and PacePay's in ink. The words come from the server's transcript of that take, not retyped.
- The **offer checker**, rows appearing in sync with the audio:
  - Wed, no fee: ✗ overdrawn
  - Fri, $35: ✗ over your fee limit
  - Fri, $20: ✓ works
- Yoshua's phone in a corner as the approval text arrives, and the YES.

The call audio itself is never re-voiced: it is the recording of the real call. Keep the graphics to about 6 seconds so the audio stays the star.

## Filming plan (Ram's room, nothing fancy)

**Before the first take:** wait for the final voice fix. Ram's Claude restarts the server and the voice worker on it and says when it's live.

Do at least three takes of the call. In order:
1. **Hook:** Yoshua at the desk, the printed quote beside the laptop. 4 seconds.
2. **The photo:** he photographs the printed quote. Use paper rather than a monitor: a screen photo gets stripes and glare, and the bill reader does better on paper. Slight angle, good light.
3. **Phone screen:** record the iPhone's screen (Control Center, Screen Recording) for the texts and the approval. iPhone screen recording mutes phone calls, so it gives picture only during calls.
4. **Call audio test take:** Ram's phone on speaker, on the desk away from the laptop, a second phone next to it recording audio. Run one full call and check that PacePay doesn't hear itself and cut itself off. If it does, lower the speaker volume or move the phones apart and test again.
5. **The call:** same setup. Ram reads the lender script below verbatim. Ram's Claude pulls the call transcript from the server after each take.
6. **The reaction:** one close-up of the iPhone buzzing, then the YES. 3 seconds.
7. **Inbound call:** Yoshua dials the PacePay number on speaker, with the second phone recording. He says the PIN (muted in the edit), then asks "What did the lender say?"
8. **Room tone:** 10 seconds of silence for the editor.

**Lender script (Ram, verbatim):**
1. Answer: "Lone Star Auto Finance, how can I help?"
2. When PacePay asks to move the Nov 10 payment to Friday, Nov 13: "I can do Wednesday."
3. When it pushes back: "Friday works, but there's a thirty-five dollar fee."
4. When it pushes back on the fee: "Okay, twenty dollars." When it reads that back: "Yes."
5. While Yoshua approves: "Take your time."
6. After it confirms: "Your reference number is A, 1, B, 2, C, 3." (Matches the dashboard's demo mode.)
7. Say goodbye and hang up after PacePay does.

Natural pauses, no jokes.

## Tasks for Ram's Claude (editing, graphics, audio)

**Dashboard footage:** screen-record the Live dashboard during every call take, for beats 3 and 4. Demo-mode clips (scripted, 1080p) are fine for:
- The four health stats.
- Try a purchase typing 900.
- Activity tab scrolling, the Arena grid.

**Graphics (render as HTML to video, brand style: Instrument Sans and DM Mono, the five-tile spectrum, Light theme):**
1. Title and close cards with the logo and tagline.
2. "$650 · Payday Thursday · −$300 on Tuesday" opening text.
3. The call UI and the offer checker (three rows), in sync with the call audio.
4. A quick architecture build from `docs/architecture.svg`: Photon → server → Nemotron → money engine (code) → Claude → LiveKit and GPT.
5. Lower thirds: "Nemotron reads the bill", "Code does the math", "Claude double-checks".
6. Three track tags at the close: PNC, NVIDIA, Photon.

**Transitions:** phone screen to dashboard (beat 4): push the phone out, land on the dashboard with the red dip sweeping green over about 1 second. Everything else is a hard cut or a quick crossfade.

**Audio:** call audio at full level, voiceover about 85%, music about 12% and ducked under every voice. Normalize to −16 LUFS. Cut dead air over half a second. Mute the PIN in the inbound call.

**Captions:** burned in, white on a soft dark bar, bottom centre, 2 lines max. For the calls, use the server transcript as the text and line it up against the recorded audio (the server's timestamps are when each line arrived, not when it was spoken). The PIN is captioned "(says PIN)". Check every caption against the audio.

**Export:** MP4, H.264, 1080p, 30 fps, **2:00 or less**, plus a 3:2 thumbnail. Upload to YouTube as unlisted and paste the link into Devpost.

## If something fails (suggestions)

- **The call drops or sounds bad:** use the best take. The lender console text mode also works; show it as "if the call drops, it falls back to text."
- **PacePay cuts itself off on speaker:** move the recording phone closer to Ram's phone and lower the speaker volume; as a last resort Ram holds the phone to his ear and the call audio comes from the voice worker instead.
- **Inbound call flakes:** cut beat 7. Take the time for the call.
- **Real footage runs long:** cut beat 7 first, then trim beat 5 to the health scores. Keep the call, the dashboard going green, and the Nemotron labels.

## Checklist before rendering

- [ ] Total runtime is under 2:00 (check the exported file, not the timeline)
- [ ] Call audio is clear and the transcript matches it
- [ ] The PIN is muted and captioned "(says PIN)"
- [ ] Every offer-checker row happened on the call that's used
- [ ] Yoshua's voiceover is recorded in a quiet room against a stopwatch
- [ ] No key, PIN sheet or personal phone number is readable on screen. The PacePay number may show only if Ram says it's safe to publish.
