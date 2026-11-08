import { describe, expect, it } from 'vitest';
import { findDollarAmount, parseReply } from '../src/replies';

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
  it('treats anything else as text', () => {
    expect(parseReply('what did they say?').kind).toBe('text');
  });
  it('finds dollar amounts', () => {
    expect(findDollarAmount('$1,200 total')).toBe(120000);
    expect(findDollarAmount('call me at 1')).toBeNull();
  });
});
