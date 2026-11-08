import { describe, expect, it } from 'vitest';
import { ModelUnavailableError } from '../src/models';
import { readBillPhoto, readBillImage, replyForPhoto, needsBillCheck, UnreadableBillError, NOT_A_BILL_TEXT, ALREADY_PAID_TEXT, coverCapacity, tooBigText } from '../src/tools/read_bill';

type Raw = Record<string, unknown> | Error;

/** Models that answer with fixed JSON per job ('vision' | 'claude'); an Error rejects. */
function fakeCtx(vision: Raw, claude: Raw | null) {
  const events: unknown[] = [];
  return {
    events,
    ctx: {
      bus: { emit: (e: unknown) => events.push(e) },
      models: {
        available: (job: string) => job !== 'claude' || claude !== null,
        chat: async (req: { role: 'vision' | 'claude'; json: { parse: (v: unknown) => unknown } }) => {
          const r = req.role === 'vision' ? vision : claude;
          if (r === null) throw new ModelUnavailableError('no claude');
          if (r instanceof Error) throw r;
          return { json: req.json.parse(r) };
        },
      },
    } as never,
  };
}

const image = { data: Buffer.from('x'), contentType: 'image/png' };
const opts = { today: '2026-11-07' as const, day0Date: '2026-11-07' as const };
const quote = { kind: 'bill', bill_count: 1, merchant: 'Northside Auto Service', amount_dollars: 650, due_date: null, due_phrase: 'due at pickup', document_date: '2026-11-07', description: 'Brake repair', confidence: 0.95 };

describe('readBillPhoto', () => {
  it('reads the demo quote: $650 due today, the reads agree', async () => {
    const { ctx } = fakeCtx(quote, quote);
    const r = await readBillPhoto(ctx, image, opts);
    expect(r.kind).toBe('bill');
    expect(r.out).toMatchObject({ merchant: 'Northside Auto Service', amount: 65000, dueDay: 0, crossCheck: { agrees: true } });
    expect(needsBillCheck(r.out!)).toBe(false);
    expect(replyForPhoto(r.kind)).toBeNull();
  });

  it('a read without "kind" (older prompt shape) is still a bill', async () => {
    const { kind: _k, bill_count: _b, ...old } = quote;
    const { ctx } = fakeCtx(old, null);
    expect((await readBillPhoto(ctx, image, opts)).out?.amount).toBe(65000);
  });

  it('not a bill: Claude decides, even when the vision model invents a bill', async () => {
    const { ctx } = fakeCtx({ ...quote, merchant: 'Selfie', amount_dollars: 12 }, { kind: 'not_a_bill', bill_count: 0, merchant: null, amount_dollars: null, description: 'A selfie', confidence: 0.99 });
    const r = await readBillPhoto(ctx, image, opts);
    expect(r).toEqual({ kind: 'not_a_bill' });
    expect(replyForPhoto(r.kind)).toBe(NOT_A_BILL_TEXT);
    await expect(readBillImage(ctx, image, opts)).rejects.toBeInstanceOf(UnreadableBillError);
  });

  it('paid receipt', async () => {
    const paid = { kind: 'paid', bill_count: 1, merchant: 'Lakeside Auto Care', amount_dollars: 148.98, description: 'Oil change', confidence: 0.95 };
    const { ctx } = fakeCtx(paid, paid);
    const r = await readBillPhoto(ctx, image, opts);
    expect(r.kind).toBe('paid');
    expect(replyForPhoto(r.kind)).toBe(ALREADY_PAID_TEXT);
  });

  it('two bills in one photo', async () => {
    const { ctx } = fakeCtx(quote, { ...quote, bill_count: 2 });
    expect((await readBillPhoto(ctx, image, opts)).kind).toBe('multiple');
  });

  it('unreadable by both: no read, so the step asks for the amount', async () => {
    const blur = { kind: 'unreadable', bill_count: 1, merchant: null, amount_dollars: null, description: 'Blurry bill', confidence: 0.1 };
    const { ctx } = fakeCtx(blur, blur);
    const r = await readBillPhoto(ctx, image, opts);
    expect(r).toEqual({ kind: 'unreadable' });
    expect(replyForPhoto(r.kind)).toBeNull();
  });

  it('a "bill" with no total counts as unreadable', async () => {
    const { ctx } = fakeCtx({ ...quote, amount_dollars: null }, null);
    expect((await readBillPhoto(ctx, image, opts)).kind).toBe('unreadable');
  });

  it('Claude unreadable wins over a vision read of the same blur (no invented totals)', async () => {
    const { ctx } = fakeCtx({ ...quote, merchant: 'Con Edison', amount_dollars: 1521.23 }, { kind: 'unreadable', amount_dollars: null, merchant: null, confidence: 0.2 });
    expect(await readBillPhoto(ctx, image, opts)).toEqual({ kind: 'unreadable' });
  });

  it('vision fails: Claude read at low confidence', async () => {
    const { ctx } = fakeCtx(new Error('timeout'), quote);
    const r = await readBillPhoto(ctx, image, opts);
    expect(r.out).toMatchObject({ amount: 65000, confidence: 0.7 });
  });

  it('a past-due bill is due today', async () => {
    const pastDue = { ...quote, merchant: 'North Texas Power', amount_dollars: 205.56, due_date: '2026-10-31', due_phrase: null, document_date: '2026-10-10' };
    const { ctx } = fakeCtx(pastDue, pastDue);
    expect((await readBillPhoto(ctx, image, opts)).out).toMatchObject({ amount: 20556, dueDay: 0 });
  });

  it('large and tiny amounts keep their cents', async () => {
    const big = { ...quote, amount_dollars: 48000, due_date: '2026-12-06', due_phrase: null };
    const { ctx } = fakeCtx(big, big);
    expect((await readBillPhoto(ctx, image, opts)).out).toMatchObject({ amount: 4800000, dueDay: 29 });
    const small = { ...quote, amount_dollars: 3, due_date: '2026-11-20', due_phrase: null };
    const s = fakeCtx(small, small);
    expect((await readBillPhoto(s.ctx, image, opts)).out).toMatchObject({ amount: 300, dueDay: 13 });
  });

  it('matching reads lift a hedged vision confidence (demo quote must not ask)', async () => {
    const { ctx } = fakeCtx({ ...quote, confidence: 0.75 }, { ...quote, confidence: 0.98 });
    const r = await readBillPhoto(ctx, image, opts);
    expect(r.out!.confidence).toBe(0.98);
    expect(needsBillCheck(r.out!)).toBe(false);
  });

  it('"due on receipt" with no printed date is due today, so both reads agree', async () => {
    const receipt = { ...quote, document_date: null, due_phrase: 'Due on receipt' };
    const { ctx } = fakeCtx(receipt, quote);
    const r = await readBillPhoto(ctx, image, opts);
    expect(r.out).toMatchObject({ dueDay: 0, crossCheck: { agrees: true } });
  });

  it('throws when no model could read it', async () => {
    const { ctx } = fakeCtx(new Error('down'), new Error('down'));
    await expect(readBillPhoto(ctx, image, opts)).rejects.toThrow('down');
  });

  it('a bill bigger than checking + savings + open card credit gets a plain answer, not options', () => {
    const accounts = [
      { kind: 'checking', balance: 195000 },
      { kind: 'savings', balance: 180000 },
      { kind: 'credit_card', balance: 280000, limit: 500000 },
      { kind: 'ira', balance: 1420000 },
    ];
    expect(coverCapacity(accounts)).toBe(595000);
    const t = tooBigText({ merchant: 'Baylor Scott & White Medical Center', amount: 4800000, dueDay: 29 }, 0, '2026-11-07');
    expect(t).toContain('$48,000 to Baylor Scott & White Medical Center, due Sun, Dec 6');
    expect(t).toContain('payment plan');
  });
});
