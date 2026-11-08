// PLACEHOLDER until the real take is exported (node scripts/video/export-thread.mjs overwrites this file).
// PacePay's lines are copied word for word from a real run of the server
// (scripts/stress/out/journeys-full2/runs/demo-call-chatty.txt). Yoshua's replies are the runbook's
// ("1", "Yes", "Yes"), so the run's "Just to check..." re-asks are left out, and the reference is
// the one Ram reads on the call (A1B2C3; that run got A7732). Images are that run's real bill photo and chart.
window.THREAD = {
  placeholder: true,
  source: 'scripts/stress/out/journeys-full2/runs/demo-call-chatty.txt',
  messages: [
    { from: 'me', kind: 'image', image: 'media/placeholder-bill.png' },
    { from: 'pacepay', kind: 'text', text: 'Got it: $650 to Northside Auto Service, due today. Checking your week.' },
    { from: 'pacepay', kind: 'image', image: 'media/placeholder-chart.png' },
    { from: 'pacepay', kind: 'text', text: 'Heads up: −$300 on Tue, Nov 10 if you pay the repair today (mortgage Mon, car payment Tue, paycheck Thu).\n1. I ask your lender to move the car payment to Fri. My pick: breaks no rules, no new debt\n2. Put it on your card: about $14/mo interest\n3. Use $400 of savings: drops below your $1,500 floor\nReply 1, 2 or 3.' },
    { from: 'me', kind: 'text', text: '1' },
    { from: 'pacepay', kind: 'text', text: "I'll ask to move it to Fri, Nov 13, with $25 max in fees. OK?" },
    { from: 'me', kind: 'text', text: 'Yes' },
    { from: 'pacepay', kind: 'text', text: 'Calling your lender now.' },
    { from: 'pacepay', kind: 'text', text: "They'll move it to Fri, Nov 13 for $20. You stay above $100. Approve? YES or NO" },
    { from: 'me', kind: 'text', text: 'Yes' },
    { from: 'pacepay', kind: 'text', text: 'Done. Car payment is now Fri, Nov 13 ($20). Ref A1B2C3.' },
  ],
};
