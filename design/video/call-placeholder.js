// Placeholder call for the video's call screen and offer checker, used only when call.js is missing.
// call.js (written by scripts/video/align-call.mjs from the real take) replaces it: same shape.
// Lines follow the lender script in docs/video-recording-sheet.md, timed into the 40s call window.
window.CALL_PLACEHOLDER = {
  placeholder: true,
  length: 40,
  // cut-time ranges of the (imaginary) raw call, so the clock shows real call time and jumps at cuts
  cuts: [
    { in: 2.0, out: 9.5 },
    { in: 14.0, out: 26.5 },
    { in: 30.0, out: 37.5 },
    { in: 61.0, out: 66.0 },
    { in: 79.0, out: 86.5 },
  ],
  lines: [
    { who: 'pacepay', start: 0.0,  end: 3.4,  text: "Hi, I'm PacePay, an AI assistant calling on behalf of Yoshua." },
    { who: 'lender',  start: 3.9,  end: 5.6,  text: 'Northside Auto Service, how can I help?' },
    { who: 'pacepay', start: 6.0,  end: 9.0,  text: 'Could we move the Nov 10 payment to Friday, Nov 13?' },
    { who: 'lender',  start: 9.4,  end: 10.8, text: 'I can do Wednesday.' },
    { who: 'pacepay', start: 11.2, end: 13.8, text: "Wednesday won't work. Is Friday possible?" },
    { who: 'lender',  start: 14.2, end: 16.6, text: "Friday works, but there's a thirty-five dollar fee." },
    { who: 'pacepay', start: 17.0, end: 19.6, text: 'Could you waive that fee, or bring it down?' },
    { who: 'lender',  start: 20.0, end: 21.4, text: 'Okay, twenty dollars.' },
    { who: 'pacepay', start: 21.8, end: 24.4, text: 'Friday the 13th with a twenty-dollar fee?' },
    { who: 'lender',  start: 24.7, end: 25.3, text: 'Yes.' },
    { who: 'pacepay', start: 25.7, end: 27.8, text: 'Let me check with Yoshua. One moment.' },
    { who: 'lender',  start: 28.1, end: 29.2, text: 'Take your time.' },
    { who: 'pacepay', start: 29.6, end: 33.6, text: 'Yoshua approved. Friday, November 13th, twenty-dollar fee. Do you have a reference number?' },
    { who: 'lender',  start: 34.0, end: 37.0, text: 'Your reference number is A, 1, B, 2, C, 3.' },
    { who: 'pacepay', start: 37.4, end: 39.6, text: 'A1B2C3. Thanks, goodbye.' },
  ],
};
