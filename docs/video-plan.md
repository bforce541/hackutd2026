# PacePay demo video: director's plan

Supersedes `video-storyboard.md`. Target length **2:50** (hard cap 3:00). 16:9, 1080p.

## The idea in one line

Lead with one real moment a judge feels in two seconds ("a $650 bill, payday's Thursday, you'd overdraw"), let the **phone call** be the hero, then zoom out so each track sees its own criteria on screen: PNC (the whole picture, the what-if), NVIDIA (Nemotron doing the work, labeled), Photon (texts and calls, in and out).

Rules for every shot:
- One idea every 8 to 10 seconds. If a shot needs more, cut it.
- Show it working before you explain it. Real phone, real call, real numbers.
- Captions burned in, so it works on mute. Music is low and never covers the call audio.
- Be honest on screen: a small tag "Demo household. The lender is played by a teammate." once, at the start of the call.

## Beat sheet

| # | Time | What we see | Who it's for |
|---|---|---|---|
| 1 | 0:00 to 0:12 | **Hook.** Yoshua at a desk with the printed repair quote and his iPhone. Text on screen: "$650 due today. Payday is Thursday." Cut to the red dip, −$300 on Tuesday. | everyone |
| 2 | 0:12 to 0:35 | **The photo.** Yoshua photographs the quote and texts it to PacePay with no question. iPhone screen recording: reply, chart image, the three options. He taps "1". | Photon, NVIDIA |
| 3 | 0:35 to 1:20 | **The call (hero).** Limits OK, then PacePay dials. Lender answers (teammate). Captions show the live transcript. Wednesday is offered and refused, then Friday for $20. Yoshua's phone buzzes, he types YES on camera, PacePay confirms out loud. | Photon voice, NVIDIA |
| 4 | 1:20 to 1:32 | **Done.** "Done. Friday, $20, ref A1B2C3." The phone screen transitions into the dashboard, and the red dip sweeps green. | everyone |
| 5 | 1:32 to 2:02 | **The whole picture (PNC).** Four health scores. What-if: type $900 in Try a purchase, the line redraws. Skip to Nov 18: the CD alert. | PNC |
| 6 | 2:02 to 2:22 | **Nemotron at work (NVIDIA).** Activity tab with a model label on every step. Arena grid. Architecture graphic. | NVIDIA |
| 7 | 2:22 to 2:40 | **The call back in (Photon).** Yoshua dials PacePay, says the PIN, asks "What did the lender say?", gets the date, fee and reference. | Photon voice |
| 8 | 2:40 to 2:50 | **Close.** Logo, tagline, three track tags, pacepay.work and the GitHub link. | everyone |

## Voiceover script (Yoshua's own voice, calm and casual)

Read it out loud once and cut anything you trip on. The call audio carries beat 3, so there's little voiceover there.

**1. Hook**
"The shop wants six hundred fifty dollars. Payday is Thursday, and my mortgage and my car payment both land first. That's how people overdraw. So I built something that handles it for me."

**2. The photo**
"I just text PacePay a photo. No question. It reads the bill, checks my whole week, and tells me: pay today and checking hits minus three hundred on Tuesday. Three options, with a pick. I tell it to ask my lender to move the car payment."

**3. The call**
"I set my limits first: twenty-five dollars max in fees. Then PacePay calls.
(call audio: the lender offers Wednesday)
Wednesday's still before payday, so the code says no, and PacePay pushes back without telling them why.
(call audio: Friday, twenty dollars)
Before it agrees, my phone buzzes. Nothing final happens without my yes."

**4. Done**
"Done. Friday, twenty dollars, reference number in my texts. And everything it did shows up here."

**5. The whole picture**
"Eight accounts, four health scores, a sixty-day forecast. The dip is gone. Want to know if you can afford something? Type it. Nine hundred dollars overdraws checking, and it shows which scores move. And later, unprompted: my CD matures. Pay off the card, and I save about five hundred fifty a year."

**6. NVIDIA**
"Nemotron runs the whole workflow. It plans, reads the bill, and decides every reply on the call. Every step is labeled with the model that did it. Claude double-checks the plan. Code does all the math. GPT only speaks. We tested it against fifty simulated lenders: [N] limit violations, [N] leaks of my balances."

**7. Photon**
"It lives in iMessage and on a real phone number. It calls out, and it takes calls in."
(call audio: Yoshua: "One two three four." ... "What did the lender say?" PacePay: the date, the fee, the reference.)

**8. Close**
"PacePay. See what's left. Buy time if you need it."

Fill `[N]` from the final Arena numbers, then read the line.

## What's on screen during the call (beat 3)

The part judges remember. Split screen:
- Left: the live transcript as captions, with the lender's lines in grey and PacePay's in ink.
- Right, appearing as it happens: the **offer checker** from the Activity tab:
  - Wed, no fee: ✗ overdrawn
  - Thu, no fee: ✗ payday (risky)
  - Fri, $35: ✗ over your fee limit
  - Fri, $20: ✓ works
- Small tag: "The voice never sees your balances."
- Yoshua's phone in a corner as the approval text arrives, with the YES.

## Filming plan (Ram's room, nothing fancy)

Film in this order. Do at least three takes of the call.
1. **Hook:** Yoshua at the desk, the printed quote beside the laptop. A slow push-in, 5 seconds.
2. **The photo:** Yoshua photographs the printed quote. Use the paper rather than a monitor: a screen photo gets stripes and glare, and the bill reader works better on paper. Lay it at a slight angle in good light.
3. **Phone screen:** record the iPhone's screen (Control Center, Screen Recording) for the whole text exchange, the approval and the inbound call. Cleaner than filming a phone.
4. **The call:** put the lender's phone on the desk on speaker. Ram answers as the lender and follows the script below. Record the room audio from a phone close to the speaker, and also have Ram's Claude pull the call transcript from the server for captions.
5. **The reaction:** one close-up of the iPhone buzzing, then the YES. 3 seconds.
6. **Inbound call:** Yoshua dials the PacePay number from his iPhone (Ram has it), says "1234", asks "What did the lender say?" Screen-record and capture the audio.
7. **Room tone:** 10 seconds of silence, for the editor.

**Lender script (Ram):** answer "Lone Star Auto Finance, how can I help?" When PacePay asks to move the Nov 10 payment to Friday, Nov 13: "I can do Wednesday." When pushed: "Friday works. There's a twenty dollar fee." Give a reference number: "A1B2C3". Natural pauses, no jokes.

## Tasks for Ram's Claude (editing, graphics, audio)

**Dashboard footage (automated):** run the dashboard in demo mode with a script and record 1080p clips, no cursor flicker:
- The dip, then the case stepped to Done with the forecast sweeping green.
- Four health stats, each clicked.
- What-if, then Try a purchase typing 900.
- Skip to Wed, Nov 18: the CD alert and "Compare in what-if".
- Activity tab scrolling, Arena grid, one transcript opened.
These are the same captures I make with a script for the gallery, so rerunning is cheap.

**Graphics (render as HTML to video, in the brand style: Instrument Sans and DM Mono, the five-tile spectrum, Light theme):**
1. Title and close cards with the logo and tagline.
2. "$650 · Payday Thursday · −$300 on Tuesday" opening text.
3. The offer checker (the four rows above) animating in, row by row, in sync with the call audio.
4. An architecture build: Photon → server → Nemotron (plans, reads, decides) → money engine (code) → Claude (checks) → LiveKit and GPT (speaks), one piece per voiceover phrase.
5. Lower thirds: "Nemotron Nano VL reads the bill", "Code does the math", "Claude double-checks".
6. Three track tags at the close: PNC, NVIDIA, Photon.

**Transitions:**
- Phone screen to dashboard (beat 4): push the phone screenshot out, and land on the dashboard with the red dip sweeping green over about 1 second.
- Everything else is a hard cut or a quick crossfade. No spins or glitches.

**Audio:**
- Mix the call audio at full level, voiceover at about 85%, music at about 12% and ducked under every voice.
- Normalize all to −16 LUFS. Cut any dead air over half a second.
- One quiet click or tick on each screen tap. No sound effects beyond that.

**Captions:** burned in, white on a soft dark bar, bottom centre, 2 lines max. For the call, use the real transcript with timestamps. Check every caption against the audio.

**Export:** MP4, H.264, 1080p, 30 fps, under 3:00, plus a 3:2 thumbnail. Upload to YouTube as unlisted, then paste the link into Devpost.

## If something fails on the day

- **The call drops or sounds bad:** use the best take. The lender console text mode also works; show it as "if the call drops, it falls back to text," which scores as a safety feature.
- **Inbound call flakes:** cut beat 7 to the paycheck-late texts: PacePay noticed Friday leans on Thursday's paycheck, and Yoshua texts "my paycheck is going to be late."
- **Real footage runs long:** drop beat 5's CD alert first, then beat 7. Never cut the call, the dashboard going green, or the Nemotron labels.
- **Arena numbers aren't final:** say "fifty simulated lenders, graded by Claude" and keep the numbers out of the voiceover.

## Checklist before rendering

- [ ] Call audio is clear, and the transcript matches it
- [ ] Arena numbers are final (or the line is trimmed)
- [ ] Yoshua's voiceover is recorded in a quiet room
- [ ] The honesty tag appears once ("Demo household. The lender is played by a teammate.")
- [ ] No key, PIN sheet or personal phone number is readable on screen. The PacePay number may show only if Ram says it's safe to publish.
- [ ] Length is 3:00 or less
