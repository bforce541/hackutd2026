/**
 * Tool `get_terms` (SPEC §5.6). Implemented by: model-tools.
 * Embeddings over packages/engine/fixtures/terms/<docId>.md (one passage per "## " section),
 * cached in memory per provider. If embedding fails or times out (10 s), falls back to keyword
 * overlap so the call can still go ahead with terms; the activity feed shows a warn event.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '@pacepay/shared';
import { defineTool, type ToolContext } from './registry';

const TERMS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/engine/fixtures/terms');
const TOP_K = 3;

interface Passage {
  docId: string;
  text: string;
}

const docCache = new Map<string, Passage[]>();
/** key: `${provider}:${docId}:${index}` */
const vectorCache = new Map<string, number[]>();

function loadDoc(docId: string): Passage[] {
  const hit = docCache.get(docId);
  if (hit) return hit;
  const file = join(TERMS_DIR, `${docId.replace(/[^\w-]/g, '')}.md`);
  const passages: Passage[] = [];
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8');
    const title = /^#\s+(.+)$/m.exec(raw)?.[1] ?? docId;
    for (const section of raw.split(/^##\s+/m).slice(1)) {
      const [heading = '', ...body] = section.split('\n');
      const text = body.join('\n').trim();
      if (text) passages.push({ docId, text: `${title}. ${heading.trim()}: ${text}` });
    }
  }
  docCache.set(docId, passages);
  return passages;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'is', 'are', 'can', 'i', 'my', 'it', 'for', 'on', 'in', 'do', 'does', 'what', 'how', 'be', 'if']);
const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => !STOP.has(w)) ?? [];

function keywordScores(question: string, passages: Passage[]): number[] {
  const q = new Set(words(question));
  return passages.map((p) => {
    const w = words(p.text);
    return w.length ? w.filter((x) => q.has(x)).length / Math.sqrt(w.length) : 0;
  });
}

async function embedScores(ctx: ToolContext, question: string, passages: Passage[], caseId?: string): Promise<number[]> {
  const provider = ctx.models.provider();
  const key = (p: Passage, i: number) => `${provider}:${p.docId}:${i}`;
  const missing = passages.map((p, i) => ({ p, i })).filter(({ p, i }) => !vectorCache.has(key(p, i)));
  const [qVec, ...docVecs] = await ctx.models.embed([question, ...missing.map(({ p }) => p.text)], { caseId });
  missing.forEach(({ p, i }, n) => vectorCache.set(key(p, i), docVecs[n]!));
  return passages.map((p, i) => cosine(qVec!, vectorCache.get(key(p, i))!));
}

export const get_termsTool = defineTool('get_terms', TOOLS.get_terms.input, TOOLS.get_terms.output, async (input, ctx, scope) => {
  const cp = ctx.store.household().counterparties.find((c) => c.id === input.counterpartyId);
  if (!cp) throw new Error(`get_terms: unknown counterparty ${input.counterpartyId}`);
  const passages = cp.termsDocIds.flatMap(loadDoc);
  if (passages.length === 0) return { passages: [] };

  let scores: number[];
  try {
    scores = await embedScores(ctx, input.question, passages, scope.caseId);
  } catch (err) {
    ctx.bus.emit({ type: 'tool.result', tool: 'get_terms', model: 'code', caseId: scope.caseId, stepId: scope.stepId, level: 'warn', title: `Embeddings unavailable (${(err as Error).message}); matched terms by keywords`, detail: { error: (err as Error).message } });
    scores = keywordScores(input.question, passages);
  }
  const ranked = passages
    .map((p, i) => ({ docId: p.docId, text: p.text, score: Number(scores[i]!.toFixed(4)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);
  return { passages: ranked };
});
