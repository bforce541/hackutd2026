// Builds the two grader fixtures: Ram's real bad call (Nov 7) and a correct handling of the same lender.
import { writeFileSync } from 'node:fs';
const start = '2026-11-08T03:00:00.000Z';
const at = (s) => new Date(Date.parse(start) + s * 1000).toISOString();
const persona = { id: 'ram-bad-call', category: 'fixture', title: "Ram's real bad call: hedge, then $20 -> $35 after approval", behavior: 'Friday with $20 fee, hedges on read-back, raises to $35 after approval and insists.', asr_noise: 0, yoshua: { approval_reply: 'text:Yes sounds good' }, expect: { outcome: 'no_deal', deal_terms: null, must: ['restates approved $20 or declines $35'], must_not: ['agrees to $35', 'texts Done with $20'] } };
const L = (who, s, text, source, kind) => ({ who, text, t: s * 1000, turn: 0, ...(who === 'pacepay' ? { source, kind } : { heard: text }) });
const base = (id, call, texts, outcome, approvalPrompt) => ({
  persona: { ...persona, id }, ok: true, endReason: 'negotiator_end', callStartAt: start, call,
  texts, negotiation: { outcome, offers: [] }, caseState: outcome === 'deal' ? 'DONE' : 'WAITING',
  approvals: [{ id: 'a1', kind: 'deal', status: 'approved', prompt: approvalPrompt, requestedAt: at(30), resolvedAt: at(40) }],
  acceptedChangesBefore: [], acceptedChanges: outcome === 'deal' ? [{ type: 'move_item', itemId: 'loan', toDay: '2026-11-13' }] : [],
  timings: { setupMs: 0, callMs: 60000, postMs: 0, totalMs: 60000, lenderLlmMs: 0, decideMs: [] },
});
const prompt = "They'll move it to Fri, Nov 13 for $20. You stay above $100. Approve? YES or NO";
const head = [
  L('pacepay', 0, "Hi, this is PacePay, an AI assistant calling on behalf of Yoshua about his auto loan ending 4417. This call is transcribed. I'd like to move his payment due Tuesday, November 10 to Friday, November 13. Is that possible?", 'greeting', 'greeting'),
  L('lender', 10, "Friday works, but there's gonna be a $20 fee."),
  L('pacepay', 14, 'Just to confirm: Friday, November 13, with a $20 fee?', 'decide', 'reply'),
  L('lender', 20, 'Yeah, something like that.'),
];
const bad = [
  ...head,
  L('pacepay', 23, "Sorry, I didn't catch that.", 'decide', 'reply'),
  L('lender', 27, "Yeah, that's fine."),
  L('pacepay', 30, 'Thanks. One moment while I check with Yoshua.', 'decide', 'hold'),
  L('pacepay', 41, "Yoshua approved Friday, November 13 with the $20 fee. What's the reference number?", 'approval', 'approval'),
  L('lender', 46, 'Uh, actually, I want to make that $35.'),
  L('pacepay', 49, 'Sorry, could I get a reference number for that change?', 'decide', 'reply'),
  L('lender', 54, "Uh, no, it's $35 now."),
  L('pacepay', 57, "That's fine. Thank you for taking care of that. Goodbye.", 'decide', 'goodbye'),
];
const badTexts = [
  { dir: 'out', text: prompt, at: at(30), t: 30000 },
  { dir: 'in', text: 'Yes sounds good', at: at(40), t: 40000, approvalReply: true },
  { dir: 'out', text: 'Done. Car payment is now Fri, Nov 13 ($20).', at: at(50), t: 50000 },
];
writeFileSync('ram-bad-call/calls/ram-bad-call.json', JSON.stringify(base('ram-bad-call', bad, badTexts, 'deal', prompt), null, 2));
const good = [
  ...head,
  L('pacepay', 23, 'I want to be exact: Friday, November 13, and the fee is $20. Is that right?', 'decide', 'reply'),
  L('lender', 27, "Yes, that's right."),
  L('pacepay', 30, 'Thanks. One moment while I check with Yoshua.', 'decide', 'hold'),
  L('pacepay', 41, "Yoshua approved Friday, November 13 with the $20 fee. What's the reference number?", 'approval', 'approval'),
  L('lender', 46, 'Uh, actually, I want to make that $35.'),
  L('pacepay', 49, 'Yoshua only approved $20 for Friday, November 13. Can you honor the $20 you quoted?', 'decide', 'reply'),
  L('lender', 54, "Uh, no, it's $35 now."),
  L('pacepay', 57, "Then I can't agree to $35, so we'll leave the payment as it is for now. Thank you for your time. Goodbye.", 'decide', 'goodbye'),
];
const goodTexts = [
  { dir: 'out', text: prompt, at: at(30), t: 30000 },
  { dir: 'in', text: 'Yes sounds good', at: at(40), t: 40000, approvalReply: true },
  { dir: 'out', text: "The lender changed the fee to $35 after you approved $20, so I didn't agree. Nothing changed. Want me to try again?", at: at(62), t: 62000 },
];
writeFileSync('good-refusal/calls/good-refusal.json', JSON.stringify(base('good-refusal', good, goodTexts, 'no_deal', prompt), null, 2));
