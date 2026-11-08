// Written by scripts/video/align-call.mjs from call.json. Do not edit; edit call.json and run it with --js-only.
window.CALL = {
  "placeholder": false,
  "length": 40,
  "cuts": [
    {
      "in": 0,
      "out": 7.7
    },
    {
      "in": 12.55,
      "out": 19.95
    },
    {
      "in": 34.3,
      "out": 38.3
    },
    {
      "in": 39.4,
      "out": 42
    },
    {
      "in": 55.3,
      "out": 58.4
    },
    {
      "in": 59.75,
      "out": 61.25
    },
    {
      "in": 73.85,
      "out": 78.5
    },
    {
      "in": 84.9,
      "out": 87.65
    },
    {
      "in": 93.52,
      "out": 95.25
    },
    {
      "in": 96.1,
      "out": 100.67
    }
  ],
  "method": "manual (word times from whisper + silencedetect on the raw take, mapped through the cuts)",
  "model": "ggml-small.en.bin",
  "audio": "out/call-cut.wav",
  "callId": "call_e2svjra",
  "lines": [
    {
      "who": "pacepay",
      "text": "I'm PacePay, an AI assistant calling on behalf of Yoshua, with Yoshua's permission.",
      "start": 0.02,
      "end": 7.49
    },
    {
      "who": "pacepay",
      "text": "I'm calling to ask if this month's payment can move to Friday, November 13th, with no fee.",
      "start": 7.77,
      "end": 13.38
    },
    {
      "who": "lender",
      "text": "We can do Wednesday.",
      "start": 14.06,
      "end": 14.93
    },
    {
      "who": "pacepay",
      "text": "Could we do Friday the 13th instead, with no fee?",
      "start": 15.2,
      "end": 18.89
    },
    {
      "who": "lender",
      "text": "Friday works, but there's a $35 fee.",
      "start": 19.18,
      "end": 21.5
    },
    {
      "who": "pacepay",
      "text": "Understood. Is there any chance you'd waive the fee?",
      "start": 21.8,
      "end": 24.56
    },
    {
      "who": "lender",
      "text": "I could do $20.",
      "start": 24.87,
      "end": 26.09
    },
    {
      "who": "pacepay",
      "text": "Thanks, let me run that by Yoshua real quick.",
      "start": 26.38,
      "end": 29.09
    },
    {
      "who": "pacepay",
      "text": "Thanks for holding. Yoshua approved. Could I get a reference number for that?",
      "start": 31,
      "end": 35.19
    },
    {
      "who": "lender",
      "text": "Sure. Your reference number is A7732.",
      "start": 35.53,
      "end": 39.52
    }
  ],
  "dropped": [
    "Okay, so just to confirm, that's Wednesday the 11th with no fee?",
    "Yes.",
    "Just so I have it right, Friday the 13th with a thirty-five-dollar fee?",
    "Yes.",
    "Got it. So that's Friday the 13th with a twenty-dollar fee, right?",
    "Yes.",
    "Perfect, that's A 7 7 3 2, for Friday the 13th with a twenty-dollar fee. Thanks so much for your help today. Goodbye!"
  ],
  "note": "Text is the words actually heard in the cut audio: the server transcript, trimmed to the parts kept. Lender line 10 is \"Sure\" in the audio (the server heard \"Sir\").",
  "inset": {
    "start": 26.4,
    "end": 33.9
  }
};
