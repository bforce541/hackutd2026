import { describe, expect, it } from 'vitest';
import {
  ackText,
  alertText,
  billCheckText,
  callingText,
  cardOptionText,
  cdAlertText,
  cdChoiceReplyText,
  chartSubtitleText,
  chartTitleText,
  contextItem,
  dealApprovalText,
  doneText,
  limitsText,
  movePaymentOptionText,
  reminderText,
  replyPrompt,
  savingsOptionText,
  statusLineText,
} from '../src/templates';

// Every expected string below is copied from UI.md "iMessage".
describe('iMessage templates', () => {
  const bill = { merchant: 'Northside Auto Service', amount: 65000, dueDay: 0, today: 0 };

  it('ack', () => {
    expect(ackText(bill)).toBe('Got it: $650 to Northside Auto Service, due today. Checking your week.');
  });

  it('alert with options', () => {
    const text = alertText({
      lowest: { amount: -30000, day: 3 },
      condition: 'if you pay the repair today',
      context: [contextItem('mortgage', 2), contextItem('car payment', 3), contextItem('paycheck', 5)],
      options: [
        movePaymentOptionText({ itemLabel: 'car payment', toDay: 6 }),
        cardOptionText({ monthlyInterest: 1354 }),
        savingsOptionText({ amount: 40000, savingsFloor: 150000, belowFloor: true }),
      ],
      pickReason: 'no new debt',
    });
    expect(text).toBe(
      [
        'Heads up: −$300 on Tue, Nov 10 if you pay the repair today (mortgage Mon, car payment Tue, paycheck Thu).',
        '1. I ask your lender to move the car payment to Fri. My pick: no new debt',
        '2. Put it on your card: about $14/mo interest',
        '3. Use $400 of savings: drops below your $1,500 floor',
        'Reply 1, 2 or 3.',
      ].join('\n'),
    );
  });

  it('reply prompts', () => {
    expect(replyPrompt(3)).toBe('Reply 1, 2 or 3.');
    expect(replyPrompt(2)).toBe('Reply 1 or 2.');
  });

  it('limits', () => {
    expect(limitsText({ toDay: 6, feeLimit: 2500 })).toBe("I'll ask to move it to Fri, Nov 13, with $25 max in fees. OK?");
  });

  it('calling', () => {
    expect(callingText()).toBe('Calling your lender now.');
  });

  it('mid-call approval', () => {
    expect(dealApprovalText({ toDay: 6, fee: 2000, checkingFloor: 10000 })).toBe(
      "They'll move it to Fri, Nov 13 for $20. You stay above $100. Approve? YES or NO",
    );
  });

  it('done', () => {
    expect(doneText({ itemLabel: 'car payment', toDay: 6, fee: 2000, reference: 'A1B2C3' })).toBe(
      'Done. Car payment is now Fri, Nov 13 ($20). Ref A1B2C3.',
    );
  });

  it('night-before reminder', () => {
    expect(reminderText({ itemLabel: 'car payment', amount: 40000, fee: 2000, when: 'tomorrow', balanceAfter: 168000 })).toBe(
      'Reminder: your $400 car payment and the $20 fee come out tomorrow. Checking will still have $1,680 after.',
    );
  });

  it('CD alert', () => {
    expect(
      cdAlertText({
        cdAmount: 500000,
        maturesOn: 13,
        payoff: 221400,
        toSavings: 278600,
        yearlySaved: 55000,
        emergencyBefore: 1800 / 3065,
        emergencyAfter: 4586 / 3065,
        renewEarned: 20500,
      }),
    ).toBe(
      [
        'Your $5,000 CD matures Fri, Nov 20.',
        '1. Pay off your card ($2,214) and put $2,786 in savings. My pick: saves about $550 a year, and your emergency fund goes from 0.6 to 1.5 months',
        '2. Renew it: earns about $205 a year',
        "Reply 1 or 2 and I'll send the steps.",
      ].join('\n'),
    );
  });

  it('CD reply after "1"', () => {
    expect(cdChoiceReplyText({ maturesOn: 13 })).toBe("Got it. I'll text you the steps Friday morning, when the CD matures.");
  });

  it('bill check', () => {
    expect(billCheckText(bill)).toBe('Is it $650 to Northside Auto Service, due today? YES or NO');
  });

  it('chart and status lines', () => {
    expect(chartTitleText({ lowest: { amount: -30000, day: 3 } })).toBe('Lowest: −$300 on Tue, Nov 10');
    expect(chartSubtitleText(14)).toBe('Checking, next 14 days');
    expect(statusLineText({ lowest: { amount: -30000, day: 3 } })).toBe('Lowest −$300 on Tue, Nov 10');
  });
});
