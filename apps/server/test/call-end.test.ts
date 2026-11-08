/** How a call ended, read from its transcript, and the honest text Yoshua gets (messaging/call-end.ts). */
import { describe, expect, it } from 'vitest';
import { callEndText, readCallEnd } from '../src/messaging/call-end';

const at = '2026-11-08T10:00:00.000Z';
const lines = (...xs: [string, string][]) => xs.map(([s, text]) => ({ at, speaker: s === 'p' ? ('pacepay' as const) : ('counterparty' as const), text }));
const text = (t: ReturnType<typeof lines>, terms?: string) => callEndText({ read: readCallEnd(t), lender: 'Lone Star', itemLabel: 'car payment', ...(terms ? { terms, termsParen: terms } : {}) });

describe('call end texts', () => {
  it('a change the lender says it processed, with its reference, is never "nothing changed"', () => {
    const t = lines(['p', 'Hi, I am PacePay...'], ['l', "Yes, that's correct, Friday, November 13th, no fee. The change has been processed. Your reference number for this update is 884291. Thank you for calling."], ['p', "Okay, I'll check with Yoshua."]);
    expect(readCallEnd(t)).toMatchObject({ kind: 'lender_processed', reference: '884291' });
    const s = text(t, 'Fri, Nov 13 (no fee)');
    expect(s).toContain('ref 884291, before you approved');
    expect(s).not.toMatch(/nothing changed/i);
  });
  it('voicemail: full mailbox vs. a message left; menus, queues and dead air', () => {
    expect(text(lines(['p', 'Hi...'], ['l', 'The mailbox you are trying to reach is full and cannot accept messages at this time. Goodbye.'], ['p', 'Hi, this is PacePay calling about a payment date for Yoshua. Goodbye.']))).toMatch(/mailbox was full, so I couldn't leave a message/);
    expect(text(lines(['p', 'Hi...'], ['l', 'Please leave a message after the beep.'], ['p', "Hi, this is PacePay calling for Yoshua about this month's payment. We'll try again later."]))).toMatch(/left a short voicemail/);
    expect(text(lines(['p', 'Hi'], ['l', 'Our offices are currently closed. Our hours are Monday through Friday. To leave a message press 2.']))).toMatch(/closed right now/);
    expect(text(lines(['p', 'Agent.'], ['l', 'All of our representatives are currently assisting other customers. Your estimated wait time is twenty five minutes.']))).toMatch(/phone queue/);
    expect(text(lines(['p', 'Hi']))).toMatch(/No one spoke/);
  });
  it("the lender's next steps and a held offer's reference ride along", () => {
    const s = text(lines(['p', 'Hi'], ['l', "We'd need a signed third-party authorization form, fax or upload it, it takes three to five business days. Your reference number is CB-4402."]));
    expect(s).toContain('signed third-party authorization form');
    expect(s).toContain('ref CB-4402');
    expect(text(lines(['p', 'Hi'], ['l', "You have until the 20th before a late fee, so you don't need to do anything."]))).toContain("no late fee until the 20th");
  });
});
