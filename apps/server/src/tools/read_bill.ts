/**
 * Tool `read_bill` (SPEC §5.6). Implemented by: model-tools.
 *
 * The vision role (Nemotron Nano 2 VL, or the VL Super in NVIDIA mode) reads merchant, amount and
 * due date; Claude reads the same image as a cross-check (skipped with a warn event when Claude is
 * unavailable or times out). Stores an unconfirmed Bill and case.billId.
 *
 * Bill-check rule (SPEC §5.2, UI.md): the agent asks Yoshua outright only when `needsBillCheck`
 * is true: the two reads disagree on amount or due date, or confidence < 0.8.
 *
 * Not every photo is a bill (a judge may text anything). The reads also say what the photo is:
 * a bill, an already-paid receipt, not a bill at all, a bill too blurry to read, or more than one
 * bill. screenBillPhoto() runs before a case opens: anything but a bill (or an unreadable bill,
 * which keeps the "text me the amount" path) gets one short reply and nothing moves. The read is
 * cached by media id, so the read_bill step in the case reuses it (no second model call).
 *
 * Due date: an ISO date on the bill becomes a demo Day. A past-due bill is due today. "Due at pickup" or "due on receipt" on a
 * bill that prints its own date is due that day (v2.md: the repair quote is "due today"); with no
 * printed date it is due today (the bill is in hand). With no due words at all, dueDay is null.
 */
import { z } from 'zod';
import { Resvg } from '@resvg/resvg-js';
import {
  TOOLS,
  dayToISODate,
  formatDayRelative,
  formatMoney,
  isoDateToDay,
  type Bill,
  type Cents,
  type Day,
  type ISODate,
  type ToolOutput,
} from '@pacepay/shared';
import { defineTool, type ToolContext } from './registry';
import { ModelUnavailableError } from '../models';
import { newId } from '../ids';

export const BILL_CONFIDENCE_FLOOR = 0.8;

const KINDS = ['bill', 'paid', 'not_a_bill', 'unreadable'] as const;
type RawKind = (typeof KINDS)[number];

const RawRead = z.object({
  kind: z.string().nullable().optional(),
  bill_count: z.number().nullable().optional(),
  merchant: z.string().nullable().optional(),
  amount_dollars: z.number().nullable().optional(),
  due_date: z.string().nullable().optional(),
  due_phrase: z.string().nullable().optional(),
  document_date: z.string().nullable().optional(),
  description: z.string().optional(),
  confidence: z.number().optional(),
});
type RawRead = z.infer<typeof RawRead>;

const SYSTEM = `You read photos people text to a bill-paying assistant. Most are bills, invoices, repair quotes or receipts, but some are anything else. Reply with JSON only, no prose:
{"kind": "bill" | "paid" | "not_a_bill" | "unreadable", "bill_count": number, "merchant": string | null, "amount_dollars": number | null, "due_date": "YYYY-MM-DD" | null, "due_phrase": string | null, "document_date": "YYYY-MM-DD" | null, "description": string, "confidence": number}
- kind:
  "bill": a bill, invoice, statement, repair quote or notice asking the customer to pay an amount (in any language; past due is still a bill).
  "paid": a receipt or invoice that is already paid and owes nothing: a PAID stamp, "paid in full", "thank you for your payment", "balance $0.00", or a card or cash payment already taken.
  "not_a_bill": anything else: people, selfies, pets, places, memes, screenshots of chats, menus, price lists, ads, products, or a blank, black or empty image. A menu with prices is not a bill.
  "unreadable": it looks like a bill but you cannot read the total (too blurry, dark, cut off). Do not guess digits; say unreadable.
- bill_count: how many separate bills or documents are in the photo (usually 1, 0 when not a bill).
- For "not_a_bill" and "unreadable", merchant and amount_dollars may be null.
- merchant: the business that is owed money, as printed.
- amount_dollars: the total the customer must pay (the final total due, not a subtotal, deposit or previous balance), in dollars with cents, e.g. 650.00.
- due_date: the date payment is due, as YYYY-MM-DD. null when the bill gives no calendar date (for example "due at pickup" or "due on receipt").
- due_phrase: when due_date is null, the printed words about when it is due (for example "due at pickup"), else null.
- document_date: the date printed on the document itself (invoice, quote or statement date), as YYYY-MM-DD, else null.
- description: at most 8 words on what the bill is for.
- confidence: 0 to 1, how sure you are of the merchant, total and due date. Lower it for blur, glare, crumpling or digits you had to guess.
Dates without a year are in the year given in the question.`;

function question(today: ISODate): string {
  return `Read this bill. Today is ${today}. Return the JSON.`;
}

export interface BillRead {
  kind: RawKind;
  billCount: number;
  merchant: string;
  amount: Cents;
  dueDay: Day | null;
  description: string;
  confidence: number;
}

function parseIso(s: string | null | undefined): ISODate | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(`${m[0]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== m[0] ? null : (m[0] as ISODate);
}

const IMMEDIATE = /pick\s?-?up|receipt|upon|immediate|today|on delivery|at completion|at service/i;

function normKind(raw: RawRead): RawKind {
  const k = (raw.kind ?? 'bill').toLowerCase().replace(/[\s-]+/g, '_');
  if ((KINDS as readonly string[]).includes(k)) return k as RawKind;
  if (/not|none|other/.test(k)) return 'not_a_bill';
  if (/paid|receipt/.test(k)) return 'paid';
  if (/blur|unread|illegible/.test(k)) return 'unreadable';
  return 'bill';
}

function toBillRead(raw: RawRead, day0Date: ISODate, today: ISODate): BillRead {
  let kind = normKind(raw);
  // A "bill" with no readable total is unreadable.
  if (kind === 'bill' && !(typeof raw.amount_dollars === 'number' && raw.amount_dollars > 0)) kind = 'unreadable';
  const docDate = parseIso(raw.document_date);
  // A due date before the bill's own date is a misread (one run read "Nov 7" as Jun 7): drop it.
  const read = parseIso(raw.due_date);
  const due = read && docDate && read < docDate ? null : read;
  let dueDay: Day | null = due ? isoDateToDay(due, day0Date) : null;
  if (dueDay === null && docDate && ((raw.due_phrase && IMMEDIATE.test(raw.due_phrase)) || (read && !due))) dueDay = isoDateToDay(docDate, day0Date);
  const todayDay = isoDateToDay(today, day0Date);
  // "Due at pickup" / "due on receipt" with no printed date: the bill is in his hand, so it's due now.
  if (dueDay === null && !read && raw.due_phrase && IMMEDIATE.test(raw.due_phrase)) dueDay = todayDay;
  // Past due (or an old statement): it's due now.
  if (dueDay !== null && dueDay < todayDay) dueDay = todayDay;
  return {
    kind,
    billCount: Math.max(0, Math.round(raw.bill_count ?? (kind === 'not_a_bill' ? 0 : 1))),
    merchant: (raw.merchant ?? '').trim() || 'your bill',
    amount: Math.max(0, Math.round((raw.amount_dollars ?? 0) * 100)),
    dueDay,
    description: (raw.description ?? '').trim(),
    confidence: Math.min(1, Math.max(0, raw.confidence ?? 0.5)),
  };
}


// Bedrock rejects request bodies over about 3.7 MB; phone photos are often larger. Photos above
// this size are shrunk (resvg decodes PNG and JPEG and re-renders them at a smaller size).
const SHRINK_ABOVE_BYTES = 1_500_000;
const SHRINK_MAX_SIDE = 1280;

function imageSize(d: Buffer): { w: number; h: number } | null {
  if (d.length > 24 && d.readUInt32BE(0) === 0x89504e47) return { w: d.readUInt32BE(16), h: d.readUInt32BE(20) };
  if (d.length > 4 && d[0] === 0xff && d[1] === 0xd8) {
    let i = 2;
    while (i + 9 < d.length) {
      if (d[i] !== 0xff) { i++; continue; }
      const marker = d[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: d.readUInt16BE(i + 5), w: d.readUInt16BE(i + 7) };
      i += 2 + d.readUInt16BE(i + 2);
    }
  }
  return null;
}

export function shrinkForVision(image: { data: Buffer; contentType: string }): { data: Buffer; contentType: string } {
  if (image.data.length <= SHRINK_ABOVE_BYTES) return image;
  const size = imageSize(image.data);
  if (!size) return image;
  const scale = Math.min(1, SHRINK_MAX_SIDE / Math.max(size.w, size.h));
  const w = Math.round(size.w * scale);
  const h = Math.round(size.h * scale);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}"><image width="${w}" height="${h}" xlink:href="data:${image.contentType};base64,${image.data.toString('base64')}"/></svg>`;
  try {
    return { data: Buffer.from(new Resvg(svg).render().asPng()), contentType: 'image/png' };
  } catch {
    return image;
  }
}

type Ctx = Pick<ToolContext, 'models' | 'bus'>;
type Scope = { caseId?: string; stepId?: string };

async function readWith(
  ctx: Ctx,
  job: 'vision' | 'claude',
  image: { data: Buffer; contentType: string },
  today: ISODate,
  day0Date: ISODate,
  scope: Scope,
): Promise<BillRead> {
  const res = await ctx.models.chat({
    role: job,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: question(today) },
    ],
    images: [image],
    json: RawRead,
    caseId: scope.caseId,
    stepId: scope.stepId,
    title: job === 'vision' ? 'Nemotron read the bill photo' : 'Claude cross-checked the bill photo',
  });
  return toBillRead(res.json, day0Date, today);
}

/** True when Yoshua must be asked: the reads disagree or the reader is unsure (SPEC §5.2). */
export function needsBillCheck(out: Pick<ToolOutput<'read_bill'>, 'confidence' | 'crossCheck'>): boolean {
  return out.confidence < BILL_CONFIDENCE_FLOOR || out.crossCheck?.agrees === false;
}

/** What a texted photo is. "multiple" is more than one bill in one photo; "too_big" is a bill larger than checking, savings and the card's open credit together. */
export type PhotoKind = RawKind | 'multiple' | 'too_big';

export const NOT_A_BILL_TEXT = "That doesn't look like a bill. Send me a photo of a bill or quote and I'll check your week.";
export const ALREADY_PAID_TEXT = 'Looks like this is already paid; nothing to do.';
export const MULTIPLE_BILLS_TEXT = "I see more than one bill in that photo. Send them one at a time and I'll check each.";

/** The one-line reply for a photo that opens no case, or null when a case should open. */
export function replyForPhoto(kind: PhotoKind): string | null {
  return kind === 'not_a_bill' ? NOT_A_BILL_TEXT : kind === 'paid' ? ALREADY_PAID_TEXT : kind === 'multiple' ? MULTIPLE_BILLS_TEXT : null;
}

/** Checking + savings + the card's open credit: the most any PacePay option could put toward a bill. */
export function coverCapacity(accounts: { kind: string; balance: Cents; limit?: Cents }[]): Cents {
  let total = 0;
  for (const a of accounts) {
    if (a.kind === 'checking' || a.kind === 'savings') total += Math.max(0, a.balance);
    if (a.kind === 'credit_card' && a.limit) total += Math.max(0, a.limit - a.balance);
  }
  return total;
}

/** A bill bigger than everything he could move: say so plainly instead of offering options that can't work. */
export function tooBigText(out: Pick<ToolOutput<'read_bill'>, 'merchant' | 'amount' | 'dueDay'>, today: Day, day0Date: ISODate): string {
  const due = out.dueDay !== null ? `, due ${formatDayRelative(out.dueDay, today, day0Date)}` : '';
  return `That's ${formatMoney(out.amount)} to ${out.merchant}${due}. That's more than your checking, savings and card could cover together, so moving a payment won't fix it. Call them and ask for a payment plan or financial assistance before it's due.`;
}

export class UnreadableBillError extends Error {
  constructor(public readonly kind: PhotoKind) {
    super(kind === 'unreadable' ? 'the photo is too unclear to read the total' : `the photo is not a bill to pay (${kind})`);
  }
}

export interface PhotoRead {
  kind: PhotoKind;
  /** The bill read, when kind is "bill". */
  out?: ToolOutput<'read_bill'>;
}

function strip(r: BillRead): ToolOutput<'read_bill'> {
  return { merchant: r.merchant, amount: r.amount, dueDay: r.dueDay, description: r.description, confidence: r.confidence };
}

/**
 * Reads a photo: vision first, Claude as the cross-check. Claude decides what the photo is when it
 * answered (it is the better judge of "is this a bill", and of "too blurry to read"); otherwise the
 * vision read does. If Claude read a bill but the vision model failed or did not, Claude's read is used
 * with confidence capped at 0.7, so the agent asks Yoshua. Throws when no model could read it.
 */
export async function readBillPhoto(
  ctx: Ctx,
  image: { data: Buffer; contentType: string },
  opts: { today: ISODate; day0Date: ISODate; caseId?: string; stepId?: string },
): Promise<PhotoRead> {
  const scope = { caseId: opts.caseId, stepId: opts.stepId };
  image = shrinkForVision(image);
  const warn = (title: string, err: unknown) =>
    ctx.bus.emit({ type: 'tool.result', tool: 'read_bill', model: 'claude-opus', caseId: opts.caseId, stepId: opts.stepId, level: 'warn', title, detail: { error: (err as Error).message } });

  const [visionRes, claudeRes] = await Promise.allSettled([
    readWith(ctx, 'vision', image, opts.today, opts.day0Date, scope),
    ctx.models.available('claude') ? readWith(ctx, 'claude', image, opts.today, opts.day0Date, scope) : Promise.reject(new ModelUnavailableError('claude is not available in this mode')),
  ]);

  const claude = claudeRes.status === 'fulfilled' ? claudeRes.value : null;
  if (claudeRes.status === 'rejected' && !(claudeRes.reason instanceof ModelUnavailableError)) warn(`Skipped the Claude bill cross-check: ${(claudeRes.reason as Error).message}`, claudeRes.reason);
  const vision = visionRes.status === 'fulfilled' ? visionRes.value : null;
  if (!vision && !claude) throw (visionRes as PromiseRejectedResult).reason;

  const judge = claude ?? vision!;
  if (judge.kind === 'bill' && judge.billCount >= 2) return { kind: 'multiple' };
  const lowConfidence = (r: BillRead): PhotoRead => ({ kind: 'bill', out: { ...strip(r), confidence: Math.min(r.confidence, 0.7) } });

  // Claude saying unreadable wins over a vision "read" of the same blur (Nemotron invents a
  // merchant and total for a blurred bill): ask him to type it instead.
  if (judge.kind !== 'bill') return { kind: judge.kind };
  if (!vision || vision.kind !== 'bill') {
    if (!vision) warn(`The bill reader failed (${(visionRes as PromiseRejectedResult).reason?.message}); using Claude's read at low confidence`, (visionRes as PromiseRejectedResult).reason);
    return lowConfidence(judge);
  }
  const out = strip(vision);
  if (claude) {
    const agrees = claude.amount === vision.amount && claude.dueDay === vision.dueDay;
    out.crossCheck = { agrees, amount: claude.amount, ...(claude.dueDay !== null ? { dueDay: claude.dueDay } : {}) };
    // Two independent reads that match exactly are good evidence even when one model hedges its
    // own confidence (Nemotron sometimes says 0.75 on the clean demo quote).
    if (agrees) out.confidence = Math.max(vision.confidence, claude.confidence);
  }
  return { kind: 'bill', out };
}

/** The bill read, or UnreadableBillError when the photo is not a readable bill. */
export async function readBillImage(
  ctx: Ctx,
  image: { data: Buffer; contentType: string },
  opts: { today: ISODate; day0Date: ISODate; caseId?: string; stepId?: string },
): Promise<ToolOutput<'read_bill'>> {
  const r = await readBillPhoto(ctx, image, opts);
  if (!r.out) throw new UnreadableBillError(r.kind);
  return r.out;
}

// Reads done by screenBillPhoto before the case opened, for the read_bill step to reuse.
const screened = new Map<string, PhotoRead | Error>();

function readOpts(ctx: Pick<ToolContext, 'clock' | 'store'>) {
  const day0Date = ctx.store.household().day0Date;
  return { today: dayToISODate(ctx.clock.today(), day0Date), day0Date };
}

/**
 * Reads a texted photo before any case opens. Returns the reply to send when the photo opens no
 * case (not a bill, already paid, more than one bill), else reply null. Never throws: a failed read
 * opens the case, and the read_bill step then asks Yoshua to type the amount.
 */
export async function screenBillPhoto(ctx: Pick<ToolContext, 'models' | 'bus' | 'clock' | 'store'>, mediaId: string): Promise<{ kind: PhotoKind | 'error'; reply: string | null }> {
  const media = ctx.store.getMedia(mediaId);
  if (!media) return { kind: 'error', reply: null };
  let r: PhotoRead | Error;
  try {
    r = await readBillPhoto(ctx, { data: media.data, contentType: media.meta.contentType }, readOpts(ctx));
  } catch (err) {
    r = err as Error;
  }
  if (!(r instanceof Error) && r.out && !needsBillCheck(r.out) && r.out.amount > coverCapacity(ctx.store.household().accounts)) {
    const o = readOpts(ctx);
    return { kind: 'too_big', reply: tooBigText(r.out, isoDateToDay(o.today, o.day0Date), o.day0Date) };
  }
  if (screened.size > 50) screened.clear();
  screened.set(mediaId, r);
  return r instanceof Error ? { kind: 'error', reply: null } : { kind: r.kind, reply: replyForPhoto(r.kind) };
}

export const read_billTool = defineTool('read_bill', TOOLS.read_bill.input, TOOLS.read_bill.output, async (input, ctx, scope) => {
  const media = ctx.store.getMedia(input.mediaId);
  if (!media) throw new Error(`read_bill: media ${input.mediaId} not found`);
  let read = screened.get(input.mediaId);
  screened.delete(input.mediaId);
  if (read === undefined) {
    read = await readBillPhoto(ctx, { data: media.data, contentType: media.meta.contentType }, { ...readOpts(ctx), caseId: scope.caseId, stepId: scope.stepId });
  }
  if (read instanceof Error) throw read;
  if (!read.out) throw new UnreadableBillError(read.kind);
  const out = read.out;

  if (scope.caseId && ctx.store.getItem('cases', scope.caseId)) {
    const bill: Bill = {
      id: newId('bill'),
      caseId: scope.caseId,
      mediaId: input.mediaId,
      ...out,
      confirmed: false,
      source: media.meta.source === 'fixture' ? 'fixture' : 'photo',
    };
    ctx.store.put('bills', bill);
    ctx.store.patch('cases', scope.caseId, { billId: bill.id });
  }
  return out;
});
