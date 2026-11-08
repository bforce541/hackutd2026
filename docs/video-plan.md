# PacePay demo video: director's plan

Supersedes `video-storyboard.md`. **Hard cap: 2:00.** Plan for **1:58**. 16:9, 1080p.

> **This is a starting point, not a spec.** Whoever edits it is free to change anything if it makes a better video. The only things that have to hold are in "Must hold" below.

## Must hold

- **2:00 or less. This is the hard limit.**
- The real phone call is the centerpiece.
- The dashboard is shown, and the Nemotron model labels are visible somewhere.
- Everything on screen is real (real texts, real call, real dashboard) and every number matches the product.
- No keys, PINs or personal numbers readable on screen.

## The shape (Ram's structure, Nov 8)

Yoshua hits a problem at his desk, texts PacePay, PacePay calls the lender, then we cut to the dashboard and explain what it is. Show it working first, explain after.

## Beat sheet (1:58)

| # | Time | What we see | Audio |
|---|---|---|---|
| 1 | 0:00 to 0:10 | **Desk.** Yoshua opens his email and sees the $650 Northside Auto Service quote. Frustrated, slaps his forehead. | Yoshua, on camera: *"Six-fifty? I don't get paid till Thursday."* |
| 2 | 0:10 to 0:22 | **Phone.** He takes out his phone and photographs the bill. The camera pushes into the phone, cut to the generated iMessage screen: photo sent, PacePay's reply, chart, three options (brief zoom on "checking hits −$300 Tue"), he taps 1, OKs the $25 fee limit, "Calling your lender now". Waits trimmed. | Message sounds, light music |
| 3 | 0:22 to 1:02 | **The call (hero).** Call thread UI over the real call audio. Offer checker rows appear as offers come in. His phone buzzes (generated iMessage, approval text), he types YES. PacePay takes the reference and says goodbye. | The real call audio, jump-cut at each lender turn |
| 4 | 1:02 to 1:06 | **Done.** The "Done" text lands on the iMessage screen, then a transition into the dashboard with the red dip sweeping green. | |
| 5 | 1:06 to 1:20 | **What PacePay is (Yoshua).** Dashboard Home. Three track tags fade in as he talks: PNC, NVIDIA, Photon. | Yoshua voiceover |
| 6 | 1:20 to 1:52 | **Dashboard tour (Ram).** Health scores, Try a purchase ($900), Activity tab (hold about 3s on a Nemotron model label), Arena grid. | Ram voiceover |
| 7 | 1:52 to 1:58 | **Close.** Clean logo card. | Music out |

Dropped from earlier versions: the cold open, the inbound call (and with it the spoken PIN), the CD alert, and naming the tracks out loud (they're on-screen tags instead).

## Voiceover

High level, not technical. Read each against a stopwatch and cut anything that runs long.

**Yoshua, beat 5 (14s, about 35 words)**
"That's PacePay. Most people don't overdraw because they're broke. They overdraw because the timing's off. PacePay watches all your money, catches it before it happens, and fixes it for you, by text or by phone."

**Ram, beat 6 (32s, about 80 words)**
"Here's the whole picture: eight accounts, four health scores, sixty days ahead. Thinking about buying something? Type it in: nine hundred dollars would overdraw checking. Every step PacePay takes shows up here, labeled with the Nemotron model that did it. And before we let it on a real call, we tested it against fifty simulated lenders. It never broke a limit and never leaked a balance."

## What's on screen during the call (beat 3)

- The **call thread UI** (`design/video/call-card.html`): PacePay cards on the left, Northside Auto Service on the right and lower, older lines sliding up and fading. Words come from the server transcript of the take we use, timed to the recorded audio.
- The **offer checker**, three rows appearing in sync with the audio:
  - Wed, no fee: ✗ overdrawn
  - Fri, $35: ✗ over your fee limit
  - Fri, $20: ✓ works
- The generated iMessage screen in a corner for the approval text and Yoshua's YES.
- No bottom captions during this beat: the thread already shows every word.

The call audio is the recording of the real call, never re-voiced.

## Filming plan (Ram's room)

**Before the first take:** wait for the final voice fix. Ram's Claude restarts the server and voice worker on it and says when it's live.

1. **Desk scene:** Yoshua at the laptop with the quote email open. Frustration, forehead slap, the line. Two or three takes.
2. **Phone up:** he takes out his phone and photographs the screen. Film the motion only; the screen itself is replaced by the generated iMessage UI.
3. **The real run:** Yoshua actually sends the photo and replies as in the script, so the server has the real thread and the real call. No screen recording needed.
4. **Call audio:** Ram's phone on speaker, on the desk away from the laptop, a second phone next to it recording audio. One test call first to check PacePay doesn't hear itself and cut itself off. Then at least three takes. Ram reads the lender script verbatim.
5. **Reaction:** close-up of his phone buzzing, then typing YES. 3 seconds.
6. **Dashboard:** screen-record the dashboard (Live, after the take) for beats 4 to 6.
7. **Voiceovers:** Yoshua and Ram each record their lines in a quiet room.
8. **Room tone:** 10 seconds of silence.

**Lender script (Ram, verbatim):**
1. Answer: "Northside Auto Service, how can I help?"
2. When PacePay asks to move the Nov 10 payment to Friday, Nov 13: "I can do Wednesday."
3. When it pushes back: "Friday works, but there's a thirty-five dollar fee."
4. When it pushes back on the fee: "Okay, twenty dollars." When it reads that back: "Yes."
5. While Yoshua approves: "Take your time."
6. After it confirms: "Your reference number is A, 1, B, 2, C, 3."
7. Say goodbye and hang up after PacePay does.

## Tasks for Ram's Claude

- **iMessage screens** (`design/video/imessage.html`): generated from the server's stored thread of the take we use, every word, the chart and the options exactly as sent. Rendered to video frame by frame, no screen recording.
- **Call thread UI** (`design/video/call-card.html`): fed the server transcript of the take, timed against the recorded audio. Rendered frame by frame.
- **Offer checker, track tags, logo close card:** brand style (Instrument Sans, DM Mono, the five-tile spectrum).
- **Transitions:** phone up into the iMessage screen (push in, then cut); "Done" text into the dashboard with the dip sweeping green. Everything else hard cuts or quick crossfades.
- **Audio:** call audio at full level, voiceover about 85%, music about 12% and ducked under every voice. Normalize to −16 LUFS. Cut dead air over half a second.
- **Captions:** burned in, bottom centre, for the desk line and the voiceovers. Off during the call (the thread shows the words).
- **Export:** MP4, H.264, 1080p, 30 fps, **2:00 or less**, plus a 3:2 thumbnail. Upload to YouTube as unlisted and paste the link into Devpost.

## If something fails

- **The call drops or sounds bad:** use the best take. The lender console text mode also works; show it as "if the call drops, it falls back to text."
- **The bill reader misreads the screen photo:** Yoshua screenshots the email on his phone and sends that instead.
- **Runs long:** trim the dashboard tour first (drop the Arena), then the desk scene. Keep the call, the dip going green, and the Nemotron label.

## Checklist before rendering

- [ ] Total runtime is under 2:00 (check the exported file, not the timeline)
- [ ] Call audio is clear and the thread UI matches it
- [ ] Every iMessage bubble matches the server's thread for that take
- [ ] Every offer-checker row happened on the call that's used
- [ ] The Nemotron model label is on screen for about 3 seconds
- [ ] No key or personal phone number readable on screen
