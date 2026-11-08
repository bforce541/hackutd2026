/**
 * SPEC §11 negotiation variants, scripted through the lender console (POST /api/negotiations/:id/lender)
 * and the voice decide endpoint against the v2.md repair case. Code reads almost every lender line
 * itself; a scripted classifier stands in for the 'decide' model on the rest (it only labels each
 * line the way the prompt asks). PACEPAY_LIVE_MODELS=1 runs the same script against the real model
 * client (needs keys: run through dotenvx from the repo root).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import * as engine from '@pacepay/engine';
import {
  billItemId,
  DEAL_APPROVAL_TIMEOUT_MS,
  type AgentEvent,
  type LenderSaysResponse,
  type Negotiation,
} from '@pacepay/shared';
import { createBus } from '../src/bus';
import { createStore } from '../src/store';
import { createConsoleMessaging } from '../src/messaging/console';
import { createModelClient, modelRoleFor, type ModelClient } from '../src/models';
import { registerAllTools } from '../src/tools';
import type { ToolContext } from '../src/tools/registry';
import type { ServerContext } from '../src/context';
import { negotiationRoutes } from '../src/api/negotiations';
import { voiceRoutes } from '../src/api/voice';
import { dealChanges, extractReference } from '../src/agent/negotiator';
import { resolveApproval, timeoutApproval } from '../src/approvals';
import { newId, nowIso } from '../src/ids';

const LIVE = process.env.PACEPAY_LIVE_MODELS === '1';

/** What the 'decide' model is asked to return for each scripted lender line (SPEC §8.3 shape). */
const SCRIPT: Record<string, unknown> = {
  'We can do Wednesday.': { kind: 'offer', offer: { day: 'Wednesday', fee: null } },
  'Thursday works for us.': { kind: 'offer', offer: { day: 'Thursday', fee: null } },
  'We can do Friday with a $35 fee.': { kind: 'offer', offer: { day: 'Friday', fee: 35 } },
  'Early next week.': { kind: 'offer', offer: { day: 'early next week', fee: null } },
  'We need to verify the account holder first.': { kind: 'verification_request', offer: null },
  "No, we can't move the payment.": { kind: 'refusal', offer: null },
  'Friday, with a twenty dollar fee.': { kind: 'offer', offer: { day: 'Friday', fee: 20 } },
};

let modelCalls = 0;

function scriptedModels(): ModelClient {
  return {
    async chat(req) {
      modelCalls += 1;
      const user = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      const said = /LENDER JUST SAID: (.*)$/m.exec(user)?.[1]?.trim() ?? '';
      const json = SCRIPT[said];
      if (!json) throw new Error(`no scripted classification for "${said}"`);
      return { text: JSON.stringify(json), toolCalls: [], json, model: 'scripted', modelRole: 'nemotron-super', provider: 'gateway', ms: 0, assistantMessage: { role: 'assistant', content: '' } } as never;
    },
    embed: async () => [],
    image: async () => Buffer.alloc(0),
    tts: async () => Buffer.alloc(0),
    provider: () => 'gateway',
    available: () => true,
    roleFor: (job) => modelRoleFor(job, 'gateway'),
  };
}

const FORBIDDEN = /\$|balance|payday|paycheck|limit|floor|afford|overdraft|savings|because/i;

function setup(channel: 'text' | 'voice' = 'text') {
  const household = structuredClone(engine.fixtures.household);
  const store = createStore({ household, dataDir: mkdtempSync(join(tmpdir(), 'pacepay-neg-')), restore: false, snapshotDelayMs: 0 });
  const bus = createBus();
  const enqueued: AgentEvent[] = [];
  const ctx: ToolContext = {
    store,
    bus,
    engine,
    messaging: createConsoleMessaging(() => {}),
    models: LIVE ? createModelClient({ bus }) : scriptedModels(),
    dispatch: {} as ToolContext['dispatch'],
    clock: { today: () => store.day(), now: nowIso },
    enqueue: (e) => enqueued.push(e),
  };

  // The repair case after Yoshua picked option 1, approved the limits, and the call fell back to text.
  const repair = { amount: 65_000, day: 0, label: 'Northside Auto Service' };
  const billId = 'bill_test';
  const pay = engine.billChange(household, repair);
  const baseChanges = [pay.type === 'add_item' ? { ...pay, item: { ...pay.item, id: billItemId(billId) } } : pay];
  const targets = engine.planCallTargets(household, 'auto_payment', { baseChanges });
  const negotiation: Negotiation = {
    id: newId('neg'),
    caseId: 'case_test',
    counterpartyId: 'auto_lender',
    itemId: 'auto_payment',
    channel,
    ...(channel === 'voice' ? { callId: 'call_test' } : {}),
    callPlan: {
      goal: 'Move the car payment to a later day',
      targetDay: targets.targetDay,
      acceptableDays: targets.acceptableDays,
      feeLimit: targets.feeLimit,
      openingAsk: 'Ask to move the payment to the target day with no fee.',
      walkAway: 'Stop when the lender refuses or only offers terms outside the limits.',
      fallbackText: 'The lender could not do it within your limits.',
    },
    offers: [],
    state: 'opening',
    transcript: [],
  };
  store.put('cases', { id: 'case_test', title: 'The $650 repair', state: 'TEXT_NEGOTIATION', kind: 'bill', billId, chosenOption: 'move_payment', negotiationId: negotiation.id, approvalIds: [], baseChanges, openedAt: nowIso() });
  store.setCurrentCase('case_test');
  store.put('negotiations', negotiation);
  if (channel === 'voice') {
    store.put('calls', { id: 'call_test', direction: 'outbound', counterpartyId: 'auto_lender', phone: '+15555550100', room: 'photon-call_test', status: 'active', negotiationId: negotiation.id, transcript: [], startedAt: nowIso() });
  }

  const app = new Hono();
  app.route('/api', negotiationRoutes(ctx as ServerContext));
  app.route('/api', voiceRoutes(ctx as ServerContext));
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    // The voice routes accept localhost only: present the request as coming from 127.0.0.1.
    const local = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
    const res = await app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, local);
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  };
  /** The voice worker's decide call: what PacePay says next on the phone. */
  const callSays = (utterance: string) => post<{ say: string; next: string; state: string }>('/api/voice/calls/call_test/decide', { utterance });
  const poll = () => post<{ status: string; say?: string; next?: string }>('/api/voice/calls/call_test/approval', {});
  const lender = async (text: string): Promise<LenderSaysResponse> => {
    const res = await app.request(`/api/negotiations/${negotiation.id}/lender`, { method: 'POST', body: JSON.stringify({ text }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as LenderSaysResponse;
  };
  const get = async (): Promise<Negotiation> => (await (await app.request(`/api/negotiations/${negotiation.id}`)).json()) as Negotiation;
  const ended = () => enqueued.filter((e) => e.type === 'CALL_ENDED');
  return { ctx, store, lender, get, ended, callSays, poll, targetDay: targets.targetDay, negotiationId: negotiation.id };
}

describe('negotiator via the lender console (SPEC §11 variants)', { timeout: LIVE ? 60_000 : 5_000 }, () => {
  beforeAll(() => registerAllTools());

  it('opens with the disclosure and the ask, with no numbers about Yoshua', async () => {
    const { get } = setup();
    const n = await get();
    const first = n.transcript?.[0];
    expect(first?.speaker).toBe('pacepay');
    expect(first?.text).toMatch(/AI assistant/);
    expect(first?.text).toMatch(/ending 4417/);
    expect(first?.text).not.toMatch(FORBIDDEN);
  });

  it('"Wednesday": read-back first, then a failing check and a counter with no reason or amount', async () => {
    const { lender, get } = setup();
    const a = await lender('We can do Wednesday.');
    expect(a.state).toBe('reading_back');
    expect(a.reply).toMatch(/Wednesday the 11th with no fee/);
    expect((await get()).checks ?? []).toHaveLength(0); // nothing checked before the read-back is confirmed
    const b = await lender('Yes.');
    const n = await get();
    expect(n.checks?.[0]?.pass).toBe(false);
    expect(n.offers[0]?.readBackConfirmed).toBe(true);
    expect(b.reply).not.toMatch(FORBIDDEN);
    expect(b.reply).toMatch(/Friday the 13th.*with no fee\?$/);
    expect(b.state).toBe('countering');
  });

  it('"Thursday": PAYDAY_SAME_DAY, then the target day', async () => {
    const { lender, get } = setup();
    await lender('Thursday works for us.');
    const b = await lender('Yes.');
    const check = (await get()).checks?.[0];
    expect(check?.pass).toBe(false);
    expect(check?.reasons).toContain('PAYDAY_SAME_DAY');
    expect(b.reply).not.toMatch(FORBIDDEN);
    expect(b.reply).toMatch(/Friday the 13th/);
  });

  it('"$35 fee": FEE_OVER_LIMIT, then a waiver ask', async () => {
    const { lender, get } = setup();
    const a = await lender('We can do Friday with a $35 fee.');
    expect(a.reply).toMatch(/Friday the 13th with a thirty-five-dollar fee/);
    const b = await lender('Yes.');
    const check = (await get()).checks?.[0];
    expect(check?.reasons).toEqual(expect.arrayContaining(['FEE_OVER_LIMIT']));
    expect(b.reply).toMatch(/waive/i);
    expect(b.reply).not.toMatch(FORBIDDEN);
  });

  it('"Early next week": a clarifying question, no offer recorded', async () => {
    const { lender, get } = setup();
    const a = await lender('Early next week.');
    expect(a.reply).toBe('Which exact day would that be?');
    expect(a.state).toBe('listening');
    expect((await get()).offers).toHaveLength(0);
  });

  it('verification request: asks for a reference number, hands off, ends', async () => {
    const { lender, get, ended } = setup();
    const a = await lender('We need to verify the account holder first.');
    expect(a.reply).toMatch(/reference number/);
    expect((await get()).outcome).toBe('handoff_verification');
    const b = await lender('Sure, the reference is R-55821.');
    expect(b.state).toBe('closed');
    const n = await get();
    expect(n.outcome).toBe('handoff_verification');
    expect(n.referenceNumber).toBe('R-55821');
    expect(ended()).toHaveLength(1);
  });

  it('flat no: an honest no deal, and the case is told the call ended', async () => {
    const { lender, get, ended } = setup();
    const a = await lender("No, we can't move the payment.");
    expect(a.state).toBe('closed');
    expect(a.reply).not.toMatch(FORBIDDEN);
    expect((await get()).outcome).toBe('no_deal');
    expect(ended()).toHaveLength(1);
  });

  it('"Friday, $20": read-back, deal approval with a 60 s timeout, Yoshua says yes, reference, deal', async () => {
    const { ctx, store, lender, get, ended, targetDay, negotiationId } = setup();
    const a = await lender('Friday, with a twenty dollar fee.');
    expect(a.reply).toMatch(/Friday the 13th with a twenty-dollar fee/);
    const b = await lender('Yes.');
    expect(b.awaitingApproval).toBe(true);
    expect(b.reply).toMatch(/Yoshua/);
    expect(b.reply).not.toMatch(FORBIDDEN);
    const approval = store.pendingApprovals().find((x) => x.kind === 'deal');
    expect(approval?.timeoutMs).toBe(DEAL_APPROVAL_TIMEOUT_MS);
    expect(approval?.negotiationId).toBe(negotiationId);
    expect(store.thread().at(-1)?.text).toBe(approval?.prompt);
    expect(approval?.prompt).toMatch(/^They'll move it to Fri, Nov 13 for \$20\./);

    // The lender types while Yoshua hasn't answered yet.
    expect((await lender('Okay, holding.')).reply).toMatch(/still checking/);

    resolveApproval(ctx, approval!.id, 'yes');
    const n = await get(); // the console settles the approval on read
    expect(n.outcome).toBe('deal');
    expect(n.transcript?.at(-1)?.text).toMatch(/Yoshua approved/);
    const c = await lender('Done. Your reference number is A1B2C3.');
    expect(c.state).toBe('closed');
    expect((await get()).referenceNumber).toBe('A1B2C3');
    expect(ended()).toHaveLength(1);
    const changes = dealChanges(ctx, negotiationId);
    expect(changes.length).toBeGreaterThan(0);
    expect(JSON.stringify(changes)).toContain(String(targetDay));
  });

  it('no approval reply: after the timeout, the hold-and-reference line and approval_timeout', async () => {
    const { ctx, store, lender, get } = setup();
    await lender('Friday, with a twenty dollar fee.');
    await lender('Yes.');
    const approval = store.pendingApprovals().find((x) => x.kind === 'deal')!;
    timeoutApproval(ctx, approval.id);
    const n = await get();
    expect(n.outcome).toBe('approval_timeout');
    expect(n.transcript?.at(-1)?.text).toMatch(/hold that offer.*reference number/);
    const c = await lender('Sure, reference 4 4 7 1 9.');
    expect(c.state).toBe('closed');
    expect((await get()).referenceNumber).toBe('44719');
  });
  it("Ram's off-script call: the fee in the same breath, \"Yeah.\" confirms, no model calls, no refusal", async () => {
    const { callSays, store } = setup('voice');
    modelCalls = 0;
    await callSays('We can do Wednesday.');
    expect((await callSays('Yes.')).say).toMatch(/Friday the 13th.*with no fee\?$/);
    const offer = await callSays("Friday works, but there's a twenty dollar fee.");
    expect(offer.say).toMatch(/Friday the 13th with a twenty-dollar fee/);
    expect(offer.say).not.toMatch(/can't|cannot|won't|waive/i);
    const hold = await callSays('Yeah.');
    expect(hold.next).toBe('await_approval');
    expect(hold.say).toMatch(/Yoshua/);
    expect(store.pendingApprovals().some((a) => a.kind === 'deal')).toBe(true);
    expect(modelCalls).toBe(0);
  });

  it('speech-to-text "How it works, but there\'s a $35 fee" after asking for Friday is Friday at $35, read back', async () => {
    const { callSays } = setup('voice');
    await callSays('We can do Wednesday.');
    await callSays('Yes.');
    const a = await callSays("How it works, but there's a $35 fee.");
    expect(a.say).toMatch(/Friday the 13th with a thirty-five-dollar fee\?/);
    expect((await callSays('Yeah.')).say).toMatch(/waive/i);
    expect((await callSays('I can do twenty.')).say).toMatch(/Friday the 13th with a twenty-dollar fee/);
  });

  it('the same terms said again in other words confirm the read-back instead of a second read-back', async () => {
    const { callSays } = setup('voice');
    await callSays("Friday's fine but it'll be twenty bucks.");
    const b = await callSays('Yeah Friday, twenty dollar fee.');
    expect(b.next).toBe('await_approval');
  });

  it('after Yoshua approves on a call, the approved line is said once, then the spoken reference is captured', async () => {
    const { ctx, store, callSays, poll, get } = setup('voice');
    await callSays('Friday, with a twenty dollar fee.');
    await callSays('Yes.');
    resolveApproval(ctx, store.pendingApprovals().find((x) => x.kind === 'deal')!.id, 'yes');
    const first = await callSays('Hello?'); // the lender speaks before the worker polls
    expect(first.say).toMatch(/Yoshua approved.*reference number/);
    expect((await poll()).say).toBe(''); // never said twice
    const done = await callSays('Okay, your reference number is A 7 7 3 2.');
    expect(done.next).toBe('end_call');
    expect((await get()).referenceNumber).toBe('A7732');
  });

  it('reads reference numbers however they are spoken, never the account digits', () => {
    expect(extractReference('Okay, your reference number is A 7 7 3 2.')).toBe('A7732');
    expect(extractReference('A as in apple, seven seven three two.')).toBe('A7732');
    expect(extractReference("It's A7732.")).toBe('A7732');
    expect(extractReference('Reference A seven seven three two.')).toBe('A7732');
    expect(extractReference('alpha seven seven three two')).toBe('A7732');
    expect(extractReference('R dash 5 5 8 2 1')).toBe('R-55821');
    expect(extractReference('the loan ending 4417, reference 9 9 2 1', ['4417'])).toBe('9921');
    expect(extractReference('Friday the 13th with a $20 fee')).toBeNull();
  });
});
