import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_DAY0, type Household } from '@pacepay/shared';
import { createBus } from '../src/bus';
import { createStore } from '../src/store';

const household: Household = {
  id: 'h',
  person: { name: 'Yoshua', phoneEnv: 'CUSTOMER_PHONE' },
  day0Date: DEMO_DAY0,
  grossAnnualIncome: 0,
  monthlyEssentials: [],
  accounts: [],
  scheduled: [],
  rules: { checkingFloor: 10000, savingsFloor: 150000, feeLimit: 2500, offLimitsAccountIds: [] },
  counterparties: [],
};

describe('bus', () => {
  it('numbers activity and SSE events with one increasing seq and replays them', () => {
    const seen: number[] = [];
    const bus = createBus();
    bus.subscribe((e) => seen.push(e.seq));
    const a = bus.emit({ type: 'demo.reset', title: 'Reset' });
    bus.publish({ event: 'clock', data: { day: 11 } });
    expect(a.seq).toBe(1);
    expect(seen).toEqual([1, 2]);
    expect(bus.since(1).map((e) => e.event)).toEqual(['clock']);
  });
});

describe('store', () => {
  it('keeps collections and resets to day 0', () => {
    const store = createStore({ household, dataDir: mkdtempSync(join(tmpdir(), 'pacepay-')), restore: false, snapshotDelayMs: 0 });
    store.put('cases', { id: 'case_1', title: 'The $650 repair', state: 'NEW', approvalIds: [] });
    store.setCurrentCase('case_1');
    store.setDay(11);
    expect(store.currentCase()?.title).toBe('The $650 repair');
    store.patch('cases', 'case_1', { state: 'ANALYZING' });
    expect(store.mustGet('cases', 'case_1').state).toBe('ANALYZING');
    store.reset(household);
    expect(store.currentCase()).toBeNull();
    expect(store.day()).toBe(0);
    store.snapshot();
  });
});
