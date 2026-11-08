import { describe, expect, it } from 'vitest';
import { fixtures } from '@pacepay/engine';
import type { Change, Household, Rules } from '@pacepay/shared';
import { parseAmount, tryPurchase } from './purchase';

const h = fixtures.household as unknown as Household;
const rules: Rules = { ...h.rules, offLimitsAccountIds: [...h.rules.offLimitsAccountIds] } as Rules;
const base = { rules, accepted: [] as Change[], day: 0, range: 14 };
const $ = (d: number) => Math.round(d * 100);

describe('parseAmount', () => {
  it('reads dollars the way people type them', () => {
    expect(parseAmount('900')).toBe($(900));
    expect(parseAmount('$1,250.50')).toBe($(1250.5));
    expect(parseAmount(' 75 ')).toBe($(75));
    expect(parseAmount('50000')).toBe($(50000));
  });
  it('rejects nothing, negatives, words and absurd sizes', () => {
    for (const bad of ['', '0', '-5', 'abc', '12.345', '12e3', '99999999', '50000.01']) expect(parseAmount(bad)).toBeNull();
  });
});

// v2.md: paying the $650 repair from checking today puts Tuesday at -$300.
describe('tryPurchase', () => {
  it('matches the $650 repair: −$300 on Tue, Nov 10, overdrawn', () => {
    const r = tryPurchase({ ...base, amount: $(650), payWith: 'checking' });
    expect(r.verdict).toBe('overdrawn');
    expect(r.lowestAfter).toEqual({ amount: $(-300), day: 3 });
    expect(r.daysBelowZeroAfter).toBeGreaterThan(0);
  });

  it('a small purchase is fine and changes nothing it should not', () => {
    const r = tryPurchase({ ...base, amount: $(50), payWith: 'checking' });
    expect(r.verdict).toBe('fine');
    expect(r.fix).toBeNull();
    expect(r.lowestAfter.amount).toBe(r.lowestNow.amount - $(50));
  });

  it('is tight when it breaks the $100 floor without going below $0', () => {
    const r = tryPurchase({ ...base, amount: $(300), payWith: 'checking' });
    expect(r.lowestAfter.amount).toBeGreaterThanOrEqual(0);
    expect(r.lowestAfter.amount).toBeLessThan(rules.checkingFloor);
    expect(r.verdict).toBe('tight');
  });

  it('the same $650 on the card leaves checking alone and moves credit use', () => {
    const r = tryPurchase({ ...base, amount: $(650), payWith: 'card' });
    expect(r.lowestAfter.amount).toBe(r.lowestNow.amount);
    const credit = r.scores.find((s) => s.key === 'credit_use')!;
    expect(credit.changed).toBe(true);
  });

  it('offers a fix that keeps checking at or above the floor when the purchase breaks it', () => {
    const r = tryPurchase({ ...base, amount: $(650), payWith: 'checking' });
    expect(r.fix).not.toBeNull();
    expect(r.fix!.lowest.amount).toBeGreaterThanOrEqual(rules.checkingFloor);
  });

  it('is deterministic', () => {
    const a = tryPurchase({ ...base, amount: $(900), payWith: 'checking' });
    const b = tryPurchase({ ...base, amount: $(900), payWith: 'checking' });
    expect(a).toEqual(b);
  });
});
