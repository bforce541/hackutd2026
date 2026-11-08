# PacePay demo video: director's plan

Supersedes `video-storyboard.md`. **Hard cap: 2:00.** Plan for **1:55** so there's a few seconds of slack. 16:9, 1080p.

> **This is a starting point, not a spec.** Whoever edits it is free to change anything: the order, the timing, the graphics, the transitions, the voiceover wording, the music, even the structure, if it makes a better video. The only things that have to hold are in "Must hold" below.

## Must hold

- **2:00 or less. This is the hard limit.**
- The real phone call is the centerpiece.
- The dashboard is shown, and the Nemotron model labels are visible somewhere.
- Everything on screen is real (real texts, real call, real dashboard) and every number matches the product.
- No keys, PINs or personal numbers readable on screen.

## The idea in one line

Lead with one moment a judge feels in two seconds ("a $650 bill, payday's Thursday, you'd overdraw"), let the **phone call** be the hero, then zoom out fast so each track sees its own criteria on screen: PNC (the whole picture, the what-if), NVIDIA (Nemotron doing the work, labeled), Photon (texts and calls, in and out).

Suggestions that tend to work at this length:
- One idea every 5 to 8 seconds. Cut anything that needs more.
- Show it working before explaining it.
- Captions burned in, so it works on mute. Music low, never over the call audio.

## Beat sheet (1:55)

| # | Time | What we see | Who it's for |
|---|---|---|---|
| 1 | 0:00 to 0:07 | **Hook.** Yoshua with the printed quote and his iPhone. Text on screen: "$650 due. Payday is Thursday." Cut to the red dip, −$300 Tuesday. | everyone |
| 2 | 0:07 to 0:20 | **The photo.** He photographs the quote and texts it with no question. iPhone screen recording: reply, chart, three options, he taps "1". | Photon, NVIDIA |
| 3 | 0:20 to 0:52 | **The call (hero).** Limits OK, PacePay dials, live captions. Wednesday refused, Friday for $20. His phone buzzes, he types YES on camera, PacePay confirms. | Photon voice, NVIDIA |
| 4 | 0:52 to 0:59 | **Done.** The text lands, the phone screen transitions into the dashboard, the red dip sweeps green. | everyone |
| 5 | 0:59 to 1:20 | **The whole picture (PNC).** Four health scores. Try a purchase: type $900, the line redraws. Skip to Nov 18: the CD alert. | PNC |
| 6 | 1:20 to 1:38 | **Nemotron at work (NVIDIA).** Activity tab with a model label on every step, the Arena grid, the architecture build. | NVIDIA |
| 7 | 1:38 to 1:48 | **The call back in (Photon).** He dials PacePay, says the PIN, asks "What did the lender say?" and gets the date, fee and reference. | Photon voice |
| 8 | 1:48 to 1:55 | **Close.** Logo, tagline, three track tags, pacepay.work and GitHub. | everyone |

## Voiceover script (Yoshua's own voice, calm and casual)

About 190 words in total; the call audio carries beat 3. Read it out loud once against a stopwatch and trim anything that runs long.

**1. Hook (7s)**
"A six hundred fifty dollar repair, payday's Thursday, and my bills land first. So I built PacePay."

**2. The photo (13s)**
"I text it a photo of the quote. It checks my week: pay today and I'm overdrawn Tuesday. Three options. I pick: ask my lender to move the car payment."

**3. The call (32s)**
"Limits set: twenty-five dollars max in fees. PacePay calls."
*(call audio: the lender offers Wednesday)*
"Wednesday's before payday, so the code says no."
*(call audio: Friday, twenty dollars)*
"My phone buzzes. Nothing's final without my yes."

**4. Done (7s)**
"Done. Friday, twenty dollars. And the forecast turns green."

**5. The whole picture (21s)**
"Eight accounts, four health scores, a sixty-day forecast. Type any purchase and watch it change: nine hundred overdraws checking. And unprompted, when my CD matures, it finds the best move: about five hundred fifty a year saved."

**6. NVIDIA (18s)**
"Nemotron plans, reads the bill and decides every reply on the call, and every step is labeled. Claude double-checks, code does the math, GPT only speaks. Tested on fifty simulated lenders: [N] limit violations."

**7. Photon (10s)**
"It's on iMessage and a real phone number. It calls out, and it takes calls in."
*(inbound audio: "One two three four." "What did the lender say?" PacePay answers.)*

**8. Close (7s)**
"PacePay. See what's left. Buy time if you need it."

Fill `[N]` from the final Arena numbers, or use "fifty simulated lenders, graded by Claude" if they aren't final.

## What's on screen during the call (beat 3)

Split screen:
- Left: the live transcript as captions, lender lines in grey and PacePay's in ink.
- Right: the **offer checker** from the Activity tab, rows appearing in sync with the audio:
  - Wed, no fee: ✗ overdrawn
  - Thu, no fee: ✗ payday (risky)
  - Fri, $35: ✗ over your fee limit
  - Fri, $20: ✓ works
- Yoshua's phone in a corner as the approval text arrives, and the YES.

Keep this to about 6 seconds of graphics so the real audio stays the star.

## Filming plan (Ram's room, nothing fancy)

Do at least three takes of the call. In order:
1. **Hook:** Yoshua at the desk, the printed quote beside the laptop. 4 seconds.
2. **The photo:** he photographs the printed quote. Use paper rather than a monitor: a screen photo gets stripes and glare, and the bill reader does better on paper. Slight angle, good light.
3. **Phone screen:** record the iPhone's screen (Control Center, Screen Recording) for the texts, the approval and the inbound call. Cleaner than filming a phone.
4. **The call:** the lender's phone on the desk on speaker, Ram answering as the lender. Capture the room audio from a phone close to the speaker, and have Ram's Claude pull the call transcript from the server for captions.
5. **The reaction:** one close-up of the iPhone buzzing, then the YES. 3 seconds.
6. **Inbound call:** Yoshua dials the PacePay number from his iPhone (Ram has it), says "1234", asks "What did the lender say?" Screen-record it and capture the audio.
7. **Room tone:** 10 seconds of silence for the editor.

**Lender script (Ram):** answer "Lone Star Auto Finance, how can I help?" When PacePay asks to move the Nov 10 payment to Friday, Nov 13: "I can do Wednesday." When pushed: "Friday works. There's a twenty dollar fee." Give a reference number: "A1B2C3". Natural pauses, no jokes.

## Tasks for Ram's Claude (editing, graphics, audio)

**Dashboard footage (automated):** run the dashboard in demo mode with a script and record 1080p clips:
- The dip, then the case stepped to Done with the forecast sweeping green.
- The four health stats.
- Try a purchase typing 900.
- Skip to Wed, Nov 18: the CD alert.
- Activity tab scrolling, the Arena grid.

**Graphics (render as HTML to video, brand style: Instrument Sans and DM Mono, the five-tile spectrum, Light theme):**
1. Title and close cards with the logo and tagline.
2. "$650 · Payday Thursday · −$300 on Tuesday" opening text.
3. The offer checker (four rows) animating in sync with the call audio.
4. An architecture build, one piece per voiceover phrase: Photon → server → Nemotron → money engine (code) → Claude → LiveKit and GPT.
5. Lower thirds: "Nemotron reads the bill", "Code does the math", "Claude double-checks".
6. Three track tags at the close: PNC, NVIDIA, Photon.

**Transitions:** phone screen to dashboard (beat 4): push the phone out, land on the dashboard with the red dip sweeping green over about 1 second. Everything else is a hard cut or a quick crossfade.

**Audio:** call audio at full level, voiceover about 85%, music about 12% and ducked under every voice. Normalize to −16 LUFS. Cut dead air over half a second.

**Captions:** burned in, white on a soft dark bar, bottom centre, 2 lines max. For the call, use the real transcript with timestamps. Check every caption against the audio.

**Export:** MP4, H.264, 1080p, 30 fps, **2:00 or less**, plus a 3:2 thumbnail. Upload to YouTube as unlisted and paste the link into Devpost.

## If something fails (suggestions)

- **The call drops or sounds bad:** use the best take. The lender console text mode also works; show it as "if the call drops, it falls back to text."
- **Inbound call flakes:** cut beat 7. Take the time for the call.
- **Real footage runs long:** drop the CD alert in beat 5 first, then beat 7. Keep the call, the dashboard going green, and the Nemotron labels.
- **Arena numbers aren't final:** say "fifty simulated lenders, graded by Claude" and leave the numbers out.

## Checklist before rendering

- [ ] Total runtime is under 2:00 (check the exported file, not the timeline)
- [ ] Call audio is clear and the transcript matches it
- [ ] Arena numbers are final (or the line is trimmed)
- [ ] Yoshua's voiceover is recorded in a quiet room against a stopwatch
- [ ] No key, PIN sheet or personal phone number is readable on screen. The PacePay number may show only if Ram says it's safe to publish.
