// Capture real dashboard stills for the video's dashboard scenes (design/video/dash-scenes.html).
//
// Drives a demo-mode dashboard (no server) headless and saves crisp stills of each state the
// scenes need, plus the on-screen boxes of the elements the camera moves to.
//
//   cd apps/dashboard && env -u SERVER_URL npx next dev -p 3100     # demo mode: no SERVER_URL
//   node scripts/video/capture-dashboard.mjs [http://localhost:3100]
//
// playwright-core is not a repo dependency. Point PLAYWRIGHT_CORE at an install of it
// (default: the scratchpad install used while making the video), and it drives the system Chrome.
//
// Writes design/video/media/dash/*.jpg and manifest.json + manifest.js (window.DASH = ...).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_CORE
  ?? '/private/tmp/claude-501/-Users-ramsarma--claude-spares-spare-xTyg3s/b8de4739-d8df-44ef-a137-af87de85b387/scratchpad/render/node_modules/playwright-core';
const { chromium } = createRequire(import.meta.url)(PW);

const BASE = process.argv[2] ?? 'http://localhost:3100';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'design/video/media/dash');
fs.mkdirSync(OUT, { recursive: true });

const VIEW = { width: 1600, height: 900 }; // 16:9, so a still fills the 1920x1080 stage at 1.2x
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'no-preference' });
const page = await context.newPage();
await page.goto(BASE, { waitUntil: 'networkidle' });
// the Next dev badge is not part of the product
await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' });
await wait(2500);

const manifest = { view: VIEW, shots: {} };

/** Box of the first visible element whose text matches, in viewport CSS px. */
async function boxOf(selector, text) {
  const loc = text ? page.locator(selector, { hasText: text }).first() : page.locator(selector).first();
  const b = await loc.boundingBox().catch(() => null);
  return b && { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) };
}

/** Smallest element whose own text is exactly `text` (for small labels like model chips). */
async function boxOfExact(text) {
  const b = await page.evaluate((text) => {
    const els = [...document.querySelectorAll('body *')].filter((el) => el.children.length === 0 && el.textContent.trim() === text);
    const el = els.find((e) => e.getBoundingClientRect().width > 0);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, text);
  return b && Object.fromEntries(Object.entries(b).map(([k, v]) => [k, +v.toFixed(1)]));
}

/** The card (rounded panel) that holds the element with this text. */
async function cardOf(text) {
  const b = await page.evaluate((text) => {
    const el = [...document.querySelectorAll('body *')].find((e) => e.children.length === 0 && e.textContent.trim().startsWith(text) && e.getBoundingClientRect().width > 0);
    let p = el;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (parseFloat(cs.borderTopLeftRadius) >= 12 && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') break;
      p = p.parentElement;
    }
    if (!p || p === document.body) return null;
    const r = p.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, text);
  return b && Object.fromEntries(Object.entries(b).map(([k, v]) => [k, +v.toFixed(1)]));
}

async function shot(name, boxes = {}) {
  const file = `${name}.jpg`;
  await page.screenshot({ path: path.join(OUT, file), type: 'jpeg', quality: 93 });
  const rects = {};
  for (const [k, fn] of Object.entries(boxes)) rects[k] = await fn();
  manifest.shots[name] = { file: `media/dash/${file}`, rects };
  console.log('captured', name, Object.keys(rects).join(', '));
}

const button = (re) => page.locator('button', { hasText: re }).first();
async function clickIf(re) {
  const b = button(re);
  if (await b.count() && await b.isEnabled().catch(() => false)) { await b.click(); return true; }
  return false;
}

const homeBoxes = {
  chart: () => cardOf('Checking'),
  panel: () => cardOf('PacePay'),
  emergency: () => boxOf('button', 'Emergency fund'),
  card: () => boxOf('button', 'Card use'),
  debt: () => boxOf('button', 'Debt vs. income'),
  networth: () => boxOf('button', 'Net worth'),
};

// 1. The case as it starts: the red dip, Heads up in the panel.
await shot('home-before', homeBoxes);

// 2. Step the demo case through the call to Done (Friday, $20, ref A1B2C3, forecast green).
await clickIf(/^Ask my lender/);
await wait(1200);
await clickIf(/^Call now/);
for (let i = 0; i < 40; i++) {
  if (await page.locator('button', { hasText: /^What happened/ }).count()) break;
  await wait(900);
  (await clickIf(/^Approve$/)) || (await clickIf(/^Ask Yoshua/)) || (await clickIf(/^Next line/));
}
await wait(2500);
await shot('home-done', homeBoxes);

// 3. What if, then Try a purchase: empty, 9, 90, 900.
await button(/^What if$/).click();
await wait(1500);
const whatifBoxes = {
  ...homeBoxes,
  panel: () => cardOf('What if'),
  purchase: () => boxOf('input[placeholder="900"]'),
};
await shot('whatif-open', whatifBoxes);
const input = page.locator('input[placeholder="900"]');
await input.click();
for (const v of ['9', '90', '900']) {
  await input.fill(v);
  await wait(v === '900' ? 1800 : 700);
  await shot(`whatif-${v}`, {
    ...whatifBoxes,
    result: () => boxOf('p, div', 'Overdraws checking'),
    lowest: () => boxOf('div, span, p', 'If you spend it'),
  });
}

// 4. Activity: the plan (model chip on every step) and the log.
await page.locator('button, a', { hasText: /^Activity$/ }).first().click();
await wait(2500);
await shot('activity', {
  plan: () => cardOf('Plan'),
  log: () => cardOf('Log'),
  planTitle: () => boxOf('p, div, h2, h3', 'plan written by Nemotron'),
  chipNanoVL: () => boxOfExact('Nemotron Nano 2 VL'),
  rowReadQuote: () => boxOf('li', 'Read the repair quote'),
});

// 5. Arena: 50 simulated lenders, the stats and the grid.
await page.locator('button, a', { hasText: /^Arena$/ }).first().click();
await wait(3500);
await shot('arena', {
  headline: () => boxOf('h1, h2, p, div', '50 lenders.'),
  stats: () => page.evaluate(() => {
    const cells = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && /^(RUNS|Runs|DISCLOSURES|Disclosures)$/.test(e.textContent.trim()));
    if (cells.length < 2) return null;
    const a = cells[0].closest('div[class]').getBoundingClientRect();
    let d = cells[1]; for (let i = 0; i < 2; i++) d = d.parentElement;
    const b = d.getBoundingClientRect();
    return { x: a.x, y: a.y, w: b.right - a.x, h: Math.max(a.height, b.height) };
  }),
  limits: () => cardOf('Limit violations'),
  disclosures: () => cardOf('Disclosures'),
  grid: () => page.evaluate(() => {
    const tiles = [...document.querySelectorAll('button')].filter((b) => /^(✓|–|−|↗)?\s*(Friendly|Fees|Firm|Vague|No|ID check|Chatty)$/.test(b.textContent.trim()));
    if (!tiles.length) return null;
    const rs = tiles.map((t) => t.getBoundingClientRect());
    const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
    return { x, y, w: Math.max(...rs.map((r) => r.right)) - x, h: Math.max(...rs.map((r) => r.bottom)) - y, tiles: rs.length };
  }),
});

await browser.close();
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(OUT, 'manifest.js'), `window.DASH = ${JSON.stringify(manifest)};\n`);
console.log('wrote', path.relative(ROOT, OUT));
