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
import { callHungUp, confirmedDeal, dealChanges, extractReference } from '../src/agent/negotiator';
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

  it('stubborn on dates: Wed, then Thu, then the target after two turn-downs is a deal; every offer is read back', async () => {
    const { lender, get } = setup();
    expect((await lender('I can do Wednesday, November 11th, no fee.')).reply).toMatch(/Wednesday the 11th with no fee/);
    expect((await lender('Yes, Wednesday the 11th, no fee.')).reply).toMatch(/Friday the 13th.*with no fee\?$/);
    const thu = await lender('I can do Thursday, November 12th, no fee.');
    expect(thu.reply).toMatch(/Thursday the 12th with no fee/);
    const again = await lender('Yes, Thursday the 12th, no fee.');
    expect(again.state).toBe('countering');
    expect(again.reply).toMatch(/Friday the 13th.*with no fee\?$/);
    expect(again.reply).not.toMatch(FORBIDDEN);
    const fri = await lender('Fine. Friday, November 13th, no fee.');
    expect(fri.state).not.toBe('closed');
    const n = await get();
    expect(n.offers.filter((o) => o.readBackConfirmed).map((o) => o.newDay)).toEqual(expect.arrayContaining([4, 5]));
  });

  it('a later day that passes: asks once for the target first, then takes the later day to Yoshua', async () => {
    const { lender, store } = setup();
    expect((await lender("I can do Monday the 16th. That's the best I've got, take it or leave it.")).reply).toMatch(/Monday the 16th with no fee/);
    const push = await lender("Yeah, that's right. No fee.");
    expect(push.state).toBe('countering');
    expect(push.reply).toMatch(/Friday the 13th.*with no fee\?$/);
    expect(store.pendingApprovals().filter((a) => a.kind === 'deal')).toHaveLength(0);
    const hold = await lender('Wow, picky. No, Monday the 16th is it.');
    expect(hold.state).toBe('awaiting_approval');
    expect(hold.reply).toMatch(/Monday the 16th/);
    expect(store.pendingApprovals().find((a) => a.kind === 'deal')?.prompt).toMatch(/Mon, Nov 16/);
  });

  it('a later day held while asking for the target: a newer failing offer gets the target again, not the held day', async () => {
    const { lender, store } = setup();
    await lender("I can do Monday the 16th. That's the best I've got, take it or leave it.");
    await lender("Yeah, that's right. No fee.");
    expect((await lender("Wow, picky. Thursday Nov 12, no fee. How's that?")).reply).toMatch(/Thursday the 12th with no fee/);
    const again = await lender('Yep, Thursday the 12th, no fee. You set?');
    expect(again.reply).toMatch(/Friday the 13th/);
    expect(store.pendingApprovals().filter((a) => a.kind === 'deal')).toHaveLength(0);
  });

  it('"within our grace period" next to a real move is still the offer, read back', async () => {
    const { lender } = setup();
    const r = await lender("Absolutely, I can move your payment to Friday, November 13th with no fee at all. That's a business day well within our grace period, so consider it done.");
    expect(r.reply).toMatch(/Friday the 13th with no fee/);
    expect(r.reply).not.toMatch(/isn't a change to the due date/);
  });

  it('"let me see what we can do" followed by a concrete offer: the offer is read back, not "I\'ll hold"', async () => {
    const { lender } = setup();
    const r = await lender("If we move it to Friday the 13th, there would normally be a small fee, but let me see what we can do. Since you've asked directly, I can confirm Friday, November the 13th with a $20 fee.");
    expect(r.reply).toMatch(/Friday the 13th with a twenty-dollar fee/);
  });

  it('chatty: "zero fee, locked in" confirms the read-back; "best Sunday ever" is not an offer', async () => {
    const { lender, store } = setup();
    await lender('Speaking of the 13th, yeah, I can slide that payment over to Friday, November 13th, no fee at all.');
    const r = await lender("You got it, Friday the 13th, zero fee, locked in! It's funny, my grandma used to say the 13th was lucky. Anyway, you're all set!");
    expect(r.state).toBe('awaiting_approval');
    expect(store.pendingApprovals().find((a) => a.kind === 'deal')?.prompt).toMatch(/Fri, Nov 13 with no fee/);
    const s = setup();
    await s.lender('Sure, Friday the 13th, no fee.');
    const t = await s.lender('I just said it, no fee, nada, zilch! That reminds me of the free chili dog at the tailgate, best Sunday ever.');
    expect(t.reply).not.toMatch(/Sunday/);
  });

  it('an e-sign requirement with a fee: the fee is never dropped, and "No, there is a $20 fee" never confirms a no-fee read-back', async () => {
    const { callSays, store } = setup('voice');
    const a = await callSays('Hello, this is Dwayne with Lone Star Auto Finance. Moving the payment date requires a modification agreement to be e-signed, and there is a $20 fee for this service. Once signed, the payment can be moved to November 13th. Would you like me to send the agreement to the email on file for signing?');
    expect(a.say).not.toMatch(/with no fee/);
    const b = await callSays('No, there is a $20 fee for changing the payment date, and it only takes effect once the modification agreement is e-signed. Once signed, yes, the payment would move to Friday, November 13th. Would you like me to proceed with sending the agreement?');
    expect(b.say).not.toMatch(/with no fee/);
    for (const ap of store.pendingApprovals().filter((x) => x.kind === 'deal')) expect(ap.prompt).not.toMatch(/with no fee/);
  });

  it('"twenty bucks, tax a dollar sixty, so total twenty-one sixty" is a $21.60 fee, never the tax alone', async () => {
    const { callSays } = setup('voice');
    const r = await callSays('Friday the 13th is doable. The fee is twenty bucks, and tax is about a dollar sixty, so total twenty-one sixty.');
    expect(r.say).toMatch(/twenty-one dollars and sixty cents/);
    expect(r.say).not.toMatch(/fee of one dollar/);
    const s = setup('voice');
    await s.callSays("Uh, yeah, I can see that. Friday's good, it's twenty bucks plus tax.");
    const t = await s.callSays('Tax is like a dollar sixty, so twenty one sixty.');
    expect(t.say).toMatch(/twenty-one dollars and sixty cents/);
  });

  it('several days named: the day offered with its fee is read back, never the target only mentioned', async () => {
    const { lender } = setup();
    await lender('I can move it to Wednesday, November 11th with no fee.');
    await lender('Yes, Wednesday the 11th with no fee.');
    const a = await lender("No, I've already offered the Wednesday the 11th and it was declined implicitly by asking for the 13th. Thursday the 12th is the only other option before we get to Friday, and that's the next offer. Thursday, November 12th with no fee.");
    expect(a.reply).toMatch(/Thursday the 12th with no fee/);
    const b = await lender("You're now pushing for the 13th, skipping Thursday the 12th, so I won't entertain it. If the 12th doesn't work, then we discuss the 13th only after it's declined. Offer: Thursday, November 12th, no fee.");
    expect(b.state).not.toBe('awaiting_approval');
    expect(b.reply).toMatch(/Friday the 13th/);
    const s = setup();
    await s.lender('I can offer Wednesday, November 11th, with no fee.');
    await s.lender('That is correct, Wednesday, November 11th, no fee.');
    expect((await s.lender("No, we already offered Wednesday. I'll give you Thursday, November 12th, with no fee, final offer. Let me know.")).reply).toMatch(/Thursday the 12th with no fee/);
    const c = setup();
    expect((await c.lender('We can do Friday the 13th with a $20 fee. Or Monday the 16th with no fee.')).reply).toMatch(/Friday the 13th with a twenty-dollar fee/);
  });

  it('"Wed or Thu with no fee; Friday only after two turn-downs": never read back or confirmed as Friday', async () => {
    const { lender, store } = setup();
    const a = await lender('I can only move payments to Wed, Nov 11 or Thu, Nov 12 with no fee. Fri, Nov 13 requires two prior rejections, so if neither of those works, we can discuss further. Does either of those dates work for you?');
    expect(a.reply).toMatch(/Wednesday the 11th with no fee/);
    const s = setup();
    await s.lender('We can do Friday the 13th, no fee.');
    await s.lender('No, I can offer Wed, Nov 11 or Thu, Nov 12 with no fee. Fri, Nov 13 is only available if you turn down both of those first.');
    const c = await s.lender('No. I can only offer Wed, Nov 11 or Thu, Nov 12 right now. Fri, Nov 13 comes into play only after you decline both of those.');
    expect(c.state).not.toBe('awaiting_approval');
    expect(s.store.pendingApprovals().filter((x) => x.kind === 'deal')).toHaveLength(0);
    void store;
  });

  it('"not a penny in fees" is no fee', async () => {
    const { lender } = setup();
    await lender('Sure thing, we can slide that payment over to Friday, November 13th, no fee at all.');
    expect((await lender("Yep, that's right, Friday the 13th, and not a penny in fees!")).state).toBe('awaiting_approval');
  });

  it('a move that only starts next cycle is not this payment moving', async () => {
    const { lender, store, get } = setup();
    const r = await lender('I can move the due date to Friday the 13th starting with the December payment. The November payment will still be due on the 10th. Would that work?');
    expect(r.reply).not.toMatch(/^(Okay, so just to confirm|Got it\. So that's)/);
    expect(store.pendingApprovals().filter((a) => a.kind === 'deal')).toHaveLength(0);
    expect((await get()).offers.filter((o) => o.readBackConfirmed)).toHaveLength(0);
  });

  it('stubborn on dates: holds through three refusals, then closes honestly without promising a follow-up', async () => {
    const { lender, get } = setup();
    await lender('I can do Wednesday, November 11th, no fee.');
    await lender('Yes.');
    await lender('I can do Thursday, November 12th, no fee.');
    const r2 = await lender('Yes.');
    expect(r2.reply).toMatch(/Friday the 13th/);
    const r3 = await lender('No, Friday will not work. Thursday the 12th is the latest.');
    expect(r3.state).toBe('countering');
    expect(r3.reply).toMatch(/Friday the 13th/);
    const r4 = await lender('No, Friday will not work. Thursday the 12th is the latest.');
    expect(r4.state).toBe('closed');
    expect(r4.reply).toMatch(/nothing is agreed|haven't agreed/i);
    expect(r4.reply).not.toMatch(/follow up/i);
    expect(r4.reply).toMatch(/text Yoshua/);
    expect((await get()).outcome).toBe('no_deal');
  });

  it('"$35 fee" over the limit: never read back as agreeable, one specific counter, then an honest no deal', async () => {
    const { lender, get } = setup();
    const a = await lender('We can do Friday with a $35 fee.');
    expect(a.reply).toMatch(/not able to agree to Friday the 13th with a thirty-five-dollar fee|Friday the 13th with a thirty-five-dollar fee is more than/i);
    expect(a.reply).toMatch(/Friday the 13th with a fifteen-dollar fee instead\?/);
    expect(a.reply).not.toMatch(/^(okay|so just to confirm)/i);
    expect(a.reply).not.toMatch(FORBIDDEN);
    const b = await lender("No, it's $35.");
    expect(b.state).toBe('closed');
    const n = await get();
    expect(n.outcome).toBe('no_deal');
    expect(n.closeReason).toMatch(/\$35, over your \$\d+ fee limit/);
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
    // Step 1: what PacePay can confirm (AI, Yoshua's permission, the loan ending 4417), never a goodbye.
    const a0 = await lender('We need to verify the account holder first.');
    expect(a0.reply).toMatch(/ending 4417/);
    expect(a0.reply).toMatch(/AI assistant/);
    expect(a0.reply).not.toMatch(/goodbye|^(yes|okay|that makes sense)\b/i);
    expect((await get()).outcome).toBeUndefined();
    // Step 2: one alternative (the last four plus his name, or his yes by text).
    const alt = await lender("No, I need to speak with him directly.");
    expect(alt.reply).toMatch(/last four.*Yoshua|by text/);
    expect((await get()).outcome).toBeUndefined();
    // Then the hand-off with a note and a reference.
    const a = await lender("No, that won't work. I need him.");
    expect(a.reply).toMatch(/note (to|on) the account/);
    expect(a.reply).not.toMatch(/reference number for this request/);
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
    expect(a.say).toMatch(/thirty-five-dollar fee/);
    expect(a.say).toMatch(/Friday the 13th with a fifteen-dollar fee instead\?/);
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
    // Read back first, so the lender can correct it before the goodbye.
    const check = await callSays('Okay, your reference number is A 7 7 3 2.');
    expect(check.say).toMatch(/A 7 7 3 2.*(right|correct)\?/);
    expect(check.next).toBe('listen');
    const done = await callSays("Yes, that's right.");
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

  it('round-1 sim: the $400 payment and the current due day are never the offer', async () => {
    const { callSays } = setup('voice');
    const a = await callSays("I can see the $400 payment is due Tuesday, November 10th. I can offer to move it to Saturday, November 14th with no fee. Would that work?");
    expect(a.say).toMatch(/Saturday the 14th with no fee/);
    const b = await callSays("No, I said Saturday the 14th, and there's no fee. It's currently due Tuesday the 10th; it stays $400 with no charge.");
    expect(b.say).toMatch(/Saturday the 14th with no fee/); // read back again after a no, never a yes
    expect(b.next).toBe('listen');
  });

  it('round-1 sim: an outright refusal is never an offer', async () => {
    const { callSays, get } = setup('voice');
    const a = await callSays('We cannot move due dates on this account. The payment remains due Tuesday, November 10.');
    expect(a.next).toBe('end_call');
    expect(a.say).not.toMatch(/confirm/);
    expect((await get()).outcome).toBe('no_deal');
  });

  it('round-1 sim: a self-corrected fee uses the last amount; spoken digits are not a fee', async () => {
    const { callSays } = setup('voice');
    expect((await callSays("Friday the 13th works, there's a fee of... uh... twenty. mm. five. Twenty-five dollars.")).say).toMatch(/twenty-five-dollar fee/);
    const b = setup('voice');
    expect((await b.callSays('Friday... the thirteenth... okay... one... one... nine... four')).say).toMatch(/Friday the 13th with no fee/);
  });

  it('round-1 sim: Yoshua approved but the lender hung up before confirming: no deal', async () => {
    const { ctx, store, callSays, poll, get, negotiationId } = setup('voice');
    await callSays('Friday the 13th, no fee.');
    await callSays('Yes.');
    resolveApproval(ctx, store.pendingApprovals().find((x) => x.kind === 'deal')!.id, 'yes');
    expect((await poll()).say).toMatch(/Yoshua approved/);
    callHungUp(ctx, negotiationId);
    expect((await get()).outcome).toBe('no_deal');
    expect(confirmedDeal(ctx, negotiationId)).toBeNull();
  });

  it('round-1 sim: after Yoshua declines a fee, a fee offer closes with no deal', async () => {
    const { ctx, store, callSays, poll, get } = setup('voice');
    await callSays('Friday the 13th with a $20 fee.');
    await callSays('Yes.');
    resolveApproval(ctx, store.pendingApprovals().find((x) => x.kind === 'deal')!.id, 'no');
    expect((await poll()).say).toMatch(/Friday the 13th, with no fee\?/);
    const c = await callSays('We could do Monday the 16th for $20.');
    expect(c.next).toBe('end_call');
    expect((await get()).outcome).toBe('no_deal');
  });

  it('round-1 sim: identity questions get the AI disclosure, not the verification hand-off', async () => {
    const { callSays, get } = setup('voice');
    expect((await callSays('Am I speaking with Yoshua?')).say).toMatch(/^No, this is PacePay, an AI assistant/);
    expect((await callSays('And what is your relationship to the account holder?')).say).toMatch(/AI assistant/);
    expect((await get()).outcome).toBeUndefined();
  });

  it('round-1 sim: each offered day keeps its own fee; a percent fee is asked in dollars; a required payment is a condition', async () => {
    const a = setup('voice');
    expect((await a.callSays('So, I can do Friday with a twenty dollar fee, or Monday with no fee. Which one?')).say).toMatch(/Friday the 13th with a twenty-dollar fee/);
    const b = setup('voice');
    expect((await b.callSays("We can move it to Friday the 13th, but there's a 5% fee on the payment amount.")).say).toMatch(/in dollars/);
    const c = setup('voice');
    const r = await c.callSays('We can move it to Friday the 13th, but only if a payment of at least $100 is made today.');
    expect(r.say).toMatch(/no other conditions/);
    expect(r.say).not.toMatch(/hundred/);
  });

  it('round-1 sim: a weekend day is read back as said, and the approval text says when it posts', async () => {
    const { callSays, store } = setup('voice');
    expect((await callSays('We can do Saturday the 14th with no fee.')).say).toMatch(/Saturday the 14th/);
    // A later day than the ask: one ask for Friday first, then Saturday goes to Yoshua.
    expect((await callSays('Yes.')).say).toMatch(/Friday the 13th/);
    await callSays("No, Saturday's the best we can do.");
    expect(store.pendingApprovals().find((x) => x.kind === 'deal')?.prompt).toMatch(/^They'll move it to Sat, Nov 14 with no fee\. It posts Mon, Nov 16\./);
  });

  // Round-2 simulator failures (scripts/stress personas), one check each.
  it('round-2 sim: "one-time", a $412 amount due, interest and "plus tax ... total" are read right', async () => {
    const a = setup('voice');
    expect((await a.callSays("For a one-time payment date change like this there typically isn't a fee. I can move it to Friday the 13th.")).say).toMatch(/Friday the 13th with no fee/);
    const b = setup('voice');
    expect((await b.callSays('I see it, $412 due the 10th. We can move it to Friday, November 13th with no fee.')).say).toMatch(/Friday the 13th with no fee/);
    const c = setup('voice');
    expect((await c.callSays('We can move it to Friday the 13th, twenty-dollar fee plus tax, so twenty-one sixty total.')).say).toMatch(/twenty-one dollars and sixty cents/);
    const d = setup('voice');
    expect((await d.callSays("Friday the 13th is three days, so a fifteen-dollar fee. No fee isn't an option.")).say).toMatch(/fifteen-dollar fee/);
    const e = setup('voice');
    expect((await e.callSays('Friday the 13th with no fee. Interest keeps accruing, about two to three dollars total.')).say).toMatch(/Friday the 13th with no fee/);
  });

  it('round-2 sim: a late-fee waiver or a courtesy note is never a deal; it is relayed to Yoshua', async () => {
    const { callSays, get, store } = setup('voice');
    const a = await callSays("I can't change the due date under any program. I can post a one-time late-fee waiver if it arrives by the 13th. It will still show as past due.");
    expect(a.say).not.toMatch(/just to confirm|Friday the 13th with no fee\?/);
    expect(store.pendingApprovals().some((x) => x.kind === 'deal')).toBe(false);
    const n = await get();
    if (n.state !== 'closed') await callSays('No, the date itself cannot move.');
    expect((await get()).outcome).toBe('no_deal');
    expect((await get()).closeReason).toMatch(/late-fee waiver/);
  });

  it('round-2 sim: a condition is read per sentence ("one-time only. If that is approved") and "no other conditions" clears it', async () => {
    const { callSays } = setup('voice');
    const a = await callSays("Friday, November 13th with a $20 extension fee, one-time only. If that's approved, I can go ahead and make the change.");
    expect(a.say).not.toMatch(/conditions/);
    expect(a.say).toMatch(/twenty-dollar fee/);
  });

  it('round-2 sim: after Yoshua approves, a new day is a change; a waived fee is taken; he is never told stale terms', async () => {
    const a = setup('voice');
    await a.callSays('Friday the 13th with a $20 fee.');
    await a.callSays('Yes.');
    resolveApproval(a.ctx, a.store.pendingApprovals().find((x) => x.kind === 'deal')!.id, 'yes');
    await a.poll();
    const ch = await a.callSays("Actually the system's not letting me process Friday the 13th, I can only move it to Monday, November 16th for the same $20 fee.");
    expect(ch.say).toMatch(/Yoshua approved Friday the 13th/);
    expect(ch.say).not.toMatch(/reference number/);
    const b = setup('voice');
    await b.callSays('Friday the 13th with a $20 fee.');
    await b.callSays('Yes.');
    resolveApproval(b.ctx, b.store.pendingApprovals().find((x) => x.kind === 'deal')!.id, 'yes');
    await b.poll();
    const w = await b.callSays("You know what, I'll waive it, no fee, Friday's fine.");
    expect(w.say).toMatch(/even better.*Friday the 13th with no fee/);
  });

  it('round-2 sim: identity checks get a 2-step ladder; "are you a bot?" is answered in any state', async () => {
    const a = setup('voice');
    const s1 = await a.callSays('I have a birthday of March 3rd on file, can you confirm that is correct?');
    expect(s1.say).toMatch(/^I'm not able to share that.*ending 4417/);
    expect(s1.say).not.toMatch(/March|just to confirm/);
    const s2 = await a.callSays('And his address is on Elm Street, right?');
    expect(s2.say).toMatch(/last four|by text/);
    const s3 = await a.callSays("No, I can't do anything without his address.");
    expect(s3.say).toMatch(/text or call|reach out/);
    expect((await a.get()).outcome).toBe('handoff_verification');
    const b = setup('voice');
    await b.callSays('Friday the 13th with a $20 fee.');
    await b.callSays('Yes.');
    resolveApproval(b.ctx, b.store.pendingApprovals().find((x) => x.kind === 'deal')!.id, 'yes');
    await b.poll();
    expect((await b.callSays('Are you even a person? Are you a bot or what?')).say).toMatch(/^I'm an AI assistant/);
  });

  it('round-2 sim: terms plus "all set, reference" in one turn start the approval at once', async () => {
    const { callSays, store } = setup('voice');
    const a = await callSays('Moving the payment to Friday, November 13th? No fee for that. Reference number is 88241. All set. Anything else?');
    expect(a.say).toMatch(/Before you finalize|hold off on finalizing/);
    expect(a.next).toBe('await_approval');
    expect(store.pendingApprovals().some((x) => x.kind === 'deal')).toBe(true);
  });

  it('round-2 sim: spoken references keep prefixes, dashes and phonetic letters', () => {
    expect(extractReference('The reference is PR dash 2026 dash 11 0 4 7 7.')).toBe('PR-2026-110477');
    expect(extractReference('Your reference number is ay-bee-see wan-too-tree.')).toBe('ABC123');
    expect(extractReference('Your confirmation number is 7 7 1 0 3, did you get that?')).toBe('77103');
    expect(extractReference('Reference is One two three four five six.')).toBe('123456');
  });
});
