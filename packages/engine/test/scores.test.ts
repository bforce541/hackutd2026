import { describe, expect, it } from 'vitest';
import { healthScores, type HealthScore } from '../src/index';
import { $, fridayDeal, h, payRepair } from './helpers';

const byKey = (scores: HealthScore[]) => Object.fromEntries(scores.map((s) => [s.key, s]));

// v2.md › "Health scores on day 0"
describe('scores.day0', () => {
  const s = byKey(healthScores(h, { changes: [payRepair] }));

  it('cash cushion is red: −$300 on Tue, Nov 10 once the quote is counted', () => {
    expect(s.cash_cushion).toMatchObject({ value: $(-300), display: '−$300', color: 'red' });
    expect(s.cash_cushion?.reason).toContain('Tue, Nov 10');
  });

  it('emergency fund is red at 0.6 months', () => {
    expect(s.emergency_fund).toMatchObject({ display: '0.6 months', color: 'red' });
  });

  it('credit use is red at 56%', () => {
    expect(s.credit_use).toMatchObject({ value: 0.56, display: '56%', color: 'red' });
  });

  it('debt-to-income is green at 35.5%', () => {
    expect(s.debt_to_income).toMatchObject({ display: '35.5%', color: 'green' });
  });

  it('before the quote, the cash cushion is green with a $350 low', () => {
    expect(byKey(healthScores(h)).cash_cushion).toMatchObject({ value: $(350), display: '$350', color: 'green' });
  });

  it('every score has a one-line reason and improve line', () => {
    for (const score of Object.values(s)) {
      expect(score.reason.length).toBeGreaterThan(10);
      expect(score.improve.length).toBeGreaterThan(10);
      expect(score.reason).not.toContain('\n');
    }
  });
});

// v2.md › "After the call, the cash cushion turns green"
describe('scores.afterCall', () => {
  it('cash cushion is green at exactly the $100 floor after the Friday deal', () => {
    expect(byKey(healthScores(h, { changes: fridayDeal })).cash_cushion).toMatchObject({ value: $(100), display: '$100', color: 'green' });
  });
});
