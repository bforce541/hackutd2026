# Demo video: what Ram and Yoshua record

Everything else (the texts, the call screen, the dashboard, the graphics, the music, the edit) is generated and timed in `design/video/timeline.json`. Nothing gets screen-recorded. You record **three things**, and each one has a window it has to fit.

Drop the files into `design/video/recordings/` with these exact names (any common format works: .mov, .mp4, .m4a, .wav). That folder is not committed.

## 1. The desk clip (`desk.mov`), 10 seconds max

- Landscape, 1080p or better, phone or camera on a stand.
- Yoshua at the laptop, the quote email open. He reads it, looks frustrated, slaps his forehead, and says:
  > "Six-fifty? I don't get paid till Thursday."
- Then he picks up his phone, takes the photo of the screen, and **raises the phone toward the camera and holds it there for 1 second**. That's where the video pushes into the phone and cuts to the generated iMessage screen.
- Do 3 takes. Keep the whole thing under 10 seconds.
- **The real text:** after the desk takes, Yoshua actually sends the bill photo to PacePay and replies 1, then Yes. That real run is what the iMessage screen and the call are built from. Don't reset the server after the take we keep until Ram's Claude has exported the thread.

## 2. The call (`call.m4a`)

- Ram's phone on speaker, on the desk away from the laptop. A second phone right next to it records audio (Voice Memos is fine).
- Quiet room. First do one test call to check PacePay doesn't hear itself and cut itself off.
- Ram reads the lender lines word for word:
  1. "Northside Auto Service, how can I help?"
  2. When PacePay asks to move the payment to Friday: "I can do Wednesday."
  3. When it pushes back: "Friday works, but there's a thirty-five dollar fee."
  4. When it pushes back on the fee: "Okay, twenty dollars." When it reads that back: "Yes."
  5. While Yoshua approves on his phone: "Take your time."
  6. After it confirms: "Your reference number is A, 1, B, 2, C, 3."
  7. Say goodbye and hang up after PacePay does.
- The raw call runs about 2 minutes. Ram's Claude cuts it to 40 seconds at the lender turns. You don't need to rush.

## 3. The voice lines, one file per line

Quiet room, phone close to your mouth, one take per file (record a few, keep the best). **Each line must fit its window**, with a little air. Read naturally; if a line runs long, trim words rather than speed up.

| File | Who | Window | Line |
|---|---|---|---|
| `yoshua-vo.m4a` | Yoshua | 13s max | "That's PacePay. Most overdrafts come down to timing. PacePay sees every account, catches the shortfall early, and fixes it by text or phone. We built it for the PNC, NVIDIA and Photon tracks." |
| `ram-health.m4a` | Ram | 7s max | "Eight accounts, and four health scores: emergency fund, card use, debt versus income, and net worth." |
| `ram-whatif.m4a` | Ram | 7s max | "Thinking about buying something? Type it in. Nine hundred dollars would overdraw checking." |
| `ram-activity.m4a` | Ram | 7s max | "Every step PacePay takes shows up here, labeled with the NVIDIA Nemotron model that did it." |
| `ram-arena.m4a` | Ram | 7s max | "We tested it against fifty simulated lenders. It never broke a limit or leaked a balance." |

## Where each recording lands (1:58)

| Time | Scene | Your recording |
|---|---|---|
| 0:00 to 0:10 | Desk | `desk.mov` |
| 0:10 to 0:22 | Generated iMessage screen | none (built from the real thread) |
| 0:22 to 1:02 | Call screen | `call.m4a`, cut to 40s |
| 1:02 to 1:06 | Done text into the dashboard | none |
| 1:06 to 1:20 | Dashboard, track tags | `yoshua-vo.m4a` |
| 1:20 to 1:28 | Health scores | `ram-health.m4a` |
| 1:28 to 1:36 | Try a purchase | `ram-whatif.m4a` |
| 1:36 to 1:44 | Activity, Nemotron labels | `ram-activity.m4a` |
| 1:44 to 1:52 | Arena | `ram-arena.m4a` |
| 1:52 to 1:58 | Logo close | none |

Once the files are in the folder, Ram's Claude renders the whole video.
