import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_DAY0, stepActor, type Approval, type Case, type Change, type Household } from '@pacepay/shared';
import { createBus } from '../src/bus';
import { createStore } from '../src/store';
import { createConsoleMessaging } from '../src/messaging/console';
import { inQuietHours, recordInbound, sendText } from '../src/messaging/outbox';
import { resolveApproval, timeoutApproval } from '../src/approvals';
import { placeCallBlockers } from '../src/agent/machine';

const household: Household = {
  id: 'h',
  person: { name: 'Yoshua', phoneEnv: 'CUSTOMER_PHONE' },
  day0Date: DEMO_DAY0,
  grossAnnualIncome: 0,
  monthlyEssentials: [],
  accounts: [],
  scheduled: [],
  rules: { checkingFloor: 10000, savingsFloor: 150000, feeLimit: 2500, offLimitsAccountIds: [], quietHours: { start: '21:00', end: '08:00' } },
  counterparties: [],
};

function makeCtx(nowIso = '2026-11-07T18:00:00.000Z') {
  const store = createStore({ household, dataDir: mkdtempSync(join(tmpdir(), 'pacepay-')), restore: false, snapshotDelayMs: 0 });
  const bus = createBus();
  const events: string[] = [];
  bus.subscribe((e) => events.push(e.event));
  return { store, bus, events, messaging: createConsoleMessaging(() => {}), clock: { today: () => store.day(), now: () => nowIso } };
}

const approval = (a: Partial<Approval> & Pick<Approval, 'id' | 'kind'>): Approval => ({
  prompt: 'p',
  choices: ['yes', 'no'],
  status: 'pending',
  requestedAt: '2026-11-07T18:00:00.000Z',
  ...a,
});

describe('store.forecastChanges', () => {
  it('adds the open case baseChanges to the accepted changes', () => {
    const { store } = makeCtx();
    const move: Change = { type: 'move_item', itemId: 'car_payment', toDay: 6 };
    const bill: Change = { type: 'add_fee', day: 0, amount: -65000, label: 'Repair' };
    store.addAcceptedChanges([move]);
    store.put('cases', { id: 'c', title: 't', state: 'ANALYZING', approvalIds: [], baseChanges: [bill] });
    store.setCurrentCase('c');
    expect(store.forecastChanges()).toEqual([move, bill]);
    store.patch('cases', 'c', { state: 'DONE' });
    expect(store.forecastChanges()).toEqual([move]);
  });
});

describe('outbox', () => {
  it('mirrors a text into the thread and publishes it', async () => {
    const ctx = makeCtx();
    const r = await sendText(ctx, 'Calling your lender now.');
    expect(r.sent).toBe(true);
    recordInbound(ctx, { text: 'ok', channel: 'imessage' });
    expect(ctx.store.thread().map((m) => m.direction)).toEqual(['out', 'in']);
    expect(ctx.events.filter((e) => e === 'thread')).toHaveLength(2);
  });

  it('holds unprompted texts in quiet hours (Chicago time) but not replies', async () => {
    expect(inQuietHours({ start: '21:00', end: '08:00' }, '2026-11-08T04:00:00.000Z')).toBe(true); // 10 PM CST
    expect(inQuietHours({ start: '21:00', end: '08:00' }, '2026-11-07T18:00:00.000Z')).toBe(false); // noon
    const ctx = makeCtx('2026-11-08T04:00:00.000Z');
    expect((await sendText(ctx, 'CD alert', { unprompted: true })).sent).toBe(false);
    expect((await sendText(ctx, 'A reply')).sent).toBe(true);
  });
});

describe('approvals', () => {
  it('resolves once, then refuses', () => {
    const ctx = makeCtx();
    ctx.store.put('approvals', approval({ id: 'a1', kind: 'deal' }));
    expect(resolveApproval(ctx, 'a1', 'yes').status).toBe('approved');
    expect(() => resolveApproval(ctx, 'a1', 'no')).toThrow(/not pending/);
    expect(timeoutApproval(ctx, 'a1').status).toBe('approved');
  });

  it('maps an option choice within optionIds only', () => {
    const ctx = makeCtx();
    ctx.store.put('approvals', approval({ id: 'a2', kind: 'option_choice', choices: ['1', '2', '3'], optionIds: ['move_payment', 'card', 'savings'] }));
    expect(() => resolveApproval(ctx, 'a2', '4')).toThrow();
    expect(resolveApproval(ctx, 'a2', '1').status).toBe('answered');
  });
});

describe('place_call gates', () => {
  const base: Case = { id: 'c', title: 't', state: 'REVIEWING', approvalIds: [], chosenOption: 'move_payment' };
  const choice = approval({ id: 'a', kind: 'option_choice', status: 'answered', answer: '1', optionIds: ['move_payment', 'card'] });
  const limits = approval({ id: 'b', kind: 'call_limits', status: 'approved', answer: 'yes' });
  const review = { verdict: 'approve' as const, issues: [], at: '2026-11-07T18:00:00.000Z' };

  it('passes only with the choice, the limits OK and a review', () => {
    expect(placeCallBlockers({ ...base, review }, [choice, limits])).toEqual([]);
    expect(placeCallBlockers({ ...base, review }, [choice])).toContain('The call limits are not approved');
    expect(placeCallBlockers(base, [choice, limits])).toContain('No second opinion yet');
    expect(placeCallBlockers({ ...base, review: { ...review, verdict: 'revise' } }, [choice, limits])).toHaveLength(1);
  });
});

describe('stepActor', () => {
  it('names Yoshua for his decisions', () => {
    expect(stepActor({ kind: 'confirm_limits', model: 'code' })).toBe('yoshua');
    expect(stepActor({ kind: 'plan_call', model: 'nemotron-ultra' })).toBe('nemotron-ultra');
  });
});
