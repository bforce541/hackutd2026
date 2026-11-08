import { describe, expect, it } from 'vitest';
import { clarifyChoiceText, clarifyYesNoText, findDollarAmount, parseReply } from '../src/replies';

describe('parseReply (SPEC §5.1)', () => {
  it('reads yes and no', () => {
    for (const t of ['yes', 'YES', 'Yes!', 'ok', 'OK', 'yep', 'approve', 'approved', 'y']) expect(parseReply(t).kind).toBe('yes');
    for (const t of ['no', 'NO', 'nope', 'decline', 'n']) expect(parseReply(t).kind).toBe('no');
  });
  it('reads a choice only within the pending options', () => {
    expect(parseReply('1', { choiceCount: 3 })).toEqual({ kind: 'choice', choice: 1 });
    expect(parseReply(' 2. ', { choiceCount: 3 })).toEqual({ kind: 'choice', choice: 2 });
    expect(parseReply('4', { choiceCount: 3 }).kind).toBe('text');
    expect(parseReply('1').kind).toBe('text');
  });
  it('checks for a correction first while the bill is unconfirmed', () => {
    expect(parseReply("it's $700", { billUnconfirmed: true })).toEqual({ kind: 'correction', amount: 70000 });
    expect(parseReply('$700.50', { billUnconfirmed: true })).toEqual({ kind: 'correction', amount: 70050 });
    expect(parseReply('700 dollars', { billUnconfirmed: true })).toEqual({ kind: 'correction', amount: 70000 });
    expect(parseReply('1', { billUnconfirmed: true, choiceCount: 3 })).toEqual({ kind: 'choice', choice: 1 });
    expect(parseReply("it's $700").kind).toBe('text');
  });
  it('reads casual approvals, punctuation and emoji', () => {
    const yes = ['Okay', 'k', 'Sure!', 'yeah', 'Ya', 'sounds good', 'Sounds good!!', 'go ahead', 'Go ahead.', 'do it', 'Do it!', '👍', '👍🏽', 'ok 👍', 'yes please', 'Yep, thanks', 'APPROVED'];
    for (const t of yes) expect(parseReply(t), t).toEqual({ kind: 'yes' });
    const no = ['nah', 'Nope.', "don't", 'Don’t', 'do not', 'stop', 'STOP!', 'cancel', 'decline', 'no thanks', "don't do it", '👎', 'not now'];
    for (const t of no) expect(parseReply(t), t).toEqual({ kind: 'no' });
  });
  it('does not read hedged or mixed replies as approvals', () => {
    for (const t of ['ok but what about the fee', 'sure, if it is cheap', 'yes and no', 'no problem', 'what do you think?', 'I do not know', 'okay so which is cheaper']) {
      expect(parseReply(t).kind, t).toBe('text');
    }
  });
  it('reads a choice by number, ordinal or phrase', () => {
    const ctx = { optionIds: ['move_payment', 'card', 'savings'] as const };
    const one = ['1', '1.', '#1', 'one', 'One!', 'option 1', 'Option one', 'the first one', 'first', 'do 1', 'Do 1!', 'number 1', 'go with 1', '1st', 'call them', 'Call the lender', 'the lender one', 'lender', 'call'];
    for (const t of one) expect(parseReply(t, ctx), t).toEqual({ kind: 'choice', choice: 1 });
    for (const t of ['2', 'two', 'second', 'the second one', 'card', 'Put it on the card', 'use my credit card', 'option 2 please']) {
      expect(parseReply(t, ctx), t).toEqual({ kind: 'choice', choice: 2 });
    }
    for (const t of ['3', 'three', 'the third one', 'savings', 'use savings', 'Use my savings']) expect(parseReply(t, ctx), t).toEqual({ kind: 'choice', choice: 3 });
  });
  it('maps option words only to options that are on offer', () => {
    expect(parseReply('call them', { optionIds: ['card', 'savings'] }).kind).toBe('text');
    expect(parseReply('savings', { optionIds: ['move_payment', 'card'] }).kind).toBe('text');
    expect(parseReply('4', { optionIds: ['move_payment', 'card', 'savings'] }).kind).toBe('text');
    expect(parseReply('the fourth one', { choiceCount: 3 }).kind).toBe('text');
    expect(parseReply('no savings', { optionIds: ['move_payment', 'card', 'savings'] }).kind).toBe('text');
    expect(parseReply('call them', { choiceCount: 3 }).kind).toBe('text');
    expect(parseReply('card', { optionIds: ['cd_payoff_card', 'cd_renew'] })).toEqual({ kind: 'choice', choice: 1 });
    expect(parseReply('renew it', { optionIds: ['cd_payoff_card', 'cd_renew'] })).toEqual({ kind: 'choice', choice: 2 });
  });
  it('words the "just to check" texts without numbers from anywhere else', () => {
    expect(clarifyChoiceText(1, 'move_payment')).toContain('Just to check, did you mean option 1, calling your lender?');
    expect(clarifyYesNoText('call_limits')).toMatch(/^Just to check/);
    expect(clarifyChoiceText(2, 'card') + clarifyYesNoText('deal')).not.toMatch(/[$%]/);
  });
  it('treats anything else as text', () => {
    expect(parseReply('what did they say?').kind).toBe('text');
  });
  it('finds dollar amounts', () => {
    expect(findDollarAmount('$1,200 total')).toBe(120000);
    expect(findDollarAmount('call me at 1')).toBeNull();
  });
});
