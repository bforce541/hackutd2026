// Generates data/bills/<id>.png for every bill in manifest.json via the TrueFoundry image API.
// Run from repo root: npx @dotenvx/dotenvx run --convention=nextjs -- node scripts/bill-photos/generate.mjs [id ...]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../data/bills');
const { bills } = JSON.parse(await fs.readFile(path.join(here, 'manifest.json'), 'utf8'));

const base = process.env.TRUEFOUNDRY_BASE_URL?.replace(/\/+$/, '').replace(/\/v1$/, '') /* this gateway serves images at <host>/images/generations */;
const key = process.env.TRUEFOUNDRY_API_KEY;
const model = process.env.IMAGE_MODEL;
if (!base || !key || !model) throw new Error('Missing TRUEFOUNDRY_BASE_URL, TRUEFOUNDRY_API_KEY or IMAGE_MODEL');

const CONCURRENCY = 4;
const RETRIES = 3;
const usd = (c) => `$${(c / 100).toFixed(2)}`;

const STYLE = {
  'flat scan': 'a clean flat scan of the paper on a white background, straight on, slight scanner noise',
  'phone photo on a table at an angle': 'a phone photo of the paper lying on a wooden table, taken at a slight angle with mild perspective and soft shadows',
  crumpled: 'a photo of a crumpled, creased, flattened paper with visible fold lines, on a table',
  'low light': 'a dim, low-light phone photo of the paper with uneven lighting and some grain, text still legible',
  'thermal receipt': 'a photo of a narrow thermal-printer receipt strip in monospace font, slightly curled, on a counter',
};

function prompt(b) {
  const lines = b.lineItems.map((l) => `  - ${l.description}: ${usd(l.amountCents)}`).join('\n');
  const due = b.dueDate ? `Due date: ${b.dueDate}` : `Payment terms: ${b.dueNote} (no calendar due date printed)`;
  return [
    `A realistic photograph of a printed ${b.category} from "${b.merchant}". Style: ${STYLE[b.photoStyle]}.`,
    'The document must show exactly this text and these numbers, spelled precisely, with no extra or different amounts:',
    `Merchant: ${b.merchant}`,
    'Line items:',
    lines,
    `TOTAL DUE: ${usd(b.totalCents)}`,
    due,
    'Render all text sharp and legible. Do not invent additional line items, totals or dates. Fictional address and phone number are fine.',
  ].join('\n');
}

async function generateOne(b) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, prompt: prompt(b), n: 1, size: '1024x1536' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const json = await res.json();
      const item = json.data?.[0];
      let buf;
      if (item?.b64_json) buf = Buffer.from(item.b64_json, 'base64');
      else if (item?.url) buf = Buffer.from(await (await fetch(item.url)).arrayBuffer());
      else throw new Error('no image in response');
      await fs.writeFile(path.join(outDir, `${b.id}.png`), buf);
      return buf.length;
    } catch (e) {
      lastErr = e;
      console.error(`${b.id} attempt ${attempt} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

await fs.mkdir(outDir, { recursive: true });
const only = new Set(process.argv.slice(2));
const queue = bills.filter((b) => !only.size || only.has(b.id));
const results = [];
let next = 0;
async function worker() {
  while (next < queue.length) {
    const b = queue[next++];
    try {
      const size = await generateOne(b);
      results.push({ id: b.id, ok: true, size });
      console.log(`${b.id} ok ${size} bytes`);
    } catch (e) {
      results.push({ id: b.id, ok: false, error: e.message });
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const ok = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);
console.log(`generated ${ok.length}/${queue.length}, failed ${failed.length}`);
if (ok.length) console.log(`average size ${Math.round(ok.reduce((s, r) => s + r.size, 0) / ok.length)} bytes`);
for (const f of failed) console.log(`FAILED ${f.id}: ${f.error}`);
process.exit(failed.length ? 1 : 0);
