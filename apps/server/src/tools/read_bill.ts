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
 * Due date: an ISO date on the bill becomes a demo Day. "Due at pickup" or "due on receipt" on a
 * bill that prints its own date is due that day (v2.md: the repair quote is "due today"). With no
 * date to anchor it, dueDay is null.
 */
import { z } from 'zod';
import { Resvg } from '@resvg/resvg-js';
import {
  TOOLS,
  dayToISODate,
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

const RawRead = z.object({
  merchant: z.string(),
  amount_dollars: z.number(),
  due_date: z.string().nullable().optional(),
  due_phrase: z.string().nullable().optional(),
  document_date: z.string().nullable().optional(),
  description: z.string().optional(),
  confidence: z.number().optional(),
});
type RawRead = z.infer<typeof RawRead>;

const SYSTEM = `You read photos of bills, invoices, repair quotes and receipts. Reply with JSON only, no prose:
{"merchant": string, "amount_dollars": number, "due_date": "YYYY-MM-DD" | null, "due_phrase": string | null, "document_date": "YYYY-MM-DD" | null, "description": string, "confidence": number}
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

function toBillRead(raw: RawRead, day0Date: ISODate): BillRead {
  const docDate = parseIso(raw.document_date);
  // A due date before the bill's own date is a misread (one run read "Nov 7" as Jun 7): drop it.
  const read = parseIso(raw.due_date);
  const due = read && docDate && read < docDate ? null : read;
  let dueDay: Day | null = due ? isoDateToDay(due, day0Date) : null;
  if (dueDay === null && docDate && ((raw.due_phrase && IMMEDIATE.test(raw.due_phrase)) || (read && !due))) dueDay = isoDateToDay(docDate, day0Date);
  return {
    merchant: raw.merchant.trim(),
    amount: Math.round(raw.amount_dollars * 100),
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
  return toBillRead(res.json, day0Date);
}

/** True when Yoshua must be asked: the reads disagree or the reader is unsure (SPEC §5.2). */
export function needsBillCheck(out: Pick<ToolOutput<'read_bill'>, 'confidence' | 'crossCheck'>): boolean {
  return out.confidence < BILL_CONFIDENCE_FLOOR || out.crossCheck?.agrees === false;
}

/**
 * Reads a bill image: vision first, Claude as the cross-check. If vision fails but Claude works,
 * Claude's read is returned with confidence capped at 0.7, so the agent asks Yoshua. Throws when
 * no model could read it (the agent then asks Yoshua to type the amount and due date).
 */
export async function readBillImage(
  ctx: Ctx,
  image: { data: Buffer; contentType: string },
  opts: { today: ISODate; day0Date: ISODate; caseId?: string; stepId?: string },
): Promise<ToolOutput<'read_bill'>> {
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

  if (visionRes.status === 'rejected') {
    if (!claude) throw visionRes.reason;
    warn(`The bill reader failed (${(visionRes.reason as Error).message}); using Claude's read at low confidence`, visionRes.reason);
    return { ...claude, confidence: Math.min(claude.confidence, 0.7) };
  }
  const read = visionRes.value;
  const out: ToolOutput<'read_bill'> = { ...read };
  if (claude) {
    const agrees = claude.amount === read.amount && claude.dueDay === read.dueDay;
    out.crossCheck = { agrees, amount: claude.amount, ...(claude.dueDay !== null ? { dueDay: claude.dueDay } : {}) };
  }
  return out;
}

export const read_billTool = defineTool('read_bill', TOOLS.read_bill.input, TOOLS.read_bill.output, async (input, ctx, scope) => {
  const media = ctx.store.getMedia(input.mediaId);
  if (!media) throw new Error(`read_bill: media ${input.mediaId} not found`);
  const out = await readBillImage(ctx, { data: media.data, contentType: media.meta.contentType }, {
    today: dayToISODate(ctx.clock.today(), ctx.store.household().day0Date),
    day0Date: ctx.store.household().day0Date,
    caseId: scope.caseId,
    stepId: scope.stepId,
  });

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
