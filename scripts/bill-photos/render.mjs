// Draws every bill in manifest.json as an SVG "photo" and renders it to PNG with @resvg/resvg-js.
// Output: data/bills-code/<id>.png. The numbers come straight from the manifest; line items must sum to the total.
// Run from anywhere: node scripts/bill-photos/render.mjs [id ...]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
// @resvg/resvg-js is installed under apps/server (no new dependency).
const require = createRequire(path.join(root, 'apps/server/package.json'));
const { Resvg } = require('@resvg/resvg-js');

const outDir = path.join(root, 'data/bills-code');
const { bills } = JSON.parse(await fs.readFile(path.join(here, 'manifest.json'), 'utf8'));

// Per photoStyle: how the photo is made to look.
const STYLE = {
  'flat scan': { table: null, paper: '#fdfdfb', rot: 0, skew: 0, blur: 0, shadow: false, grain: 0.05, dim: 1 },
  'phone photo on a table at an angle': { table: '#8a6746', paper: '#f5f1e6', rot: -3.2, skew: 1.6, blur: 0.8, shadow: true, grain: 0.12, dim: 0.97 },
  crumpled: { table: '#7d776b', paper: '#ebe6d6', rot: 2.4, skew: -0.8, blur: 0.5, shadow: true, grain: 0.16, dim: 0.93, crumple: true },
  'low light': { table: '#17191f', paper: '#d6d2c6', rot: 1.2, skew: 0.6, blur: 1.1, shadow: true, grain: 0.3, dim: 0.6, vignette: true },
  'thermal receipt': { table: '#a7a59e', paper: '#f7f6f1', rot: -1.8, skew: 0, blur: 0.5, shadow: true, grain: 0.07, dim: 0.96, thermal: true },
};

const SANS = "Helvetica, Arial, sans-serif";
const MONO = "Menlo, 'Courier New', monospace";

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function money(cents) {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function dueLine(b) {
  if (b.dueDate) {
    const d = new Date(`${b.dueDate}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    return `Due ${d}`;
  }
  const note = b.dueNote ?? 'due on receipt';
  return note.charAt(0).toUpperCase() + note.slice(1);
}

// Small seeded PRNG so each bill's folds and specks are the same on every run.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function checkBill(b) {
  const sum = b.lineItems.reduce((s, l) => s + l.amountCents, 0);
  if (sum !== b.totalCents) throw new Error(`${b.id}: line items sum to ${sum}, total is ${b.totalCents}`);
  if (!STYLE[b.photoStyle]) throw new Error(`${b.id}: unknown photoStyle "${b.photoStyle}"`);
}

// The printed content in paper coordinates (0..W wide). Returns SVG parts and the bottom y.
function paperContent(b, { W, pad, thermal, fam, y0 }) {
  const parts = [];
  const x0 = pad;
  const x1 = W - pad;
  const headSize = thermal ? 22 : 34;
  const bodySize = thermal ? 19 : 28;
  const lh = thermal ? 34 : 52;
  const ink = '#1b1b19';

  const text = (x, y, s, { size = bodySize, weight = 400, anchor = 'start', fill = ink, style = '', spacing = 0 } = {}) =>
    `<text x="${x}" y="${y}" font-family="${fam}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${fill}" font-style="${style}" letter-spacing="${spacing}">${esc(s)}</text>`;
  const rule = (y) => `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${ink}" stroke-width="${thermal ? 1.5 : 2}" stroke-dasharray="${thermal ? '4 4' : ''}" />`;

  let y = y0 + headSize;
  parts.push(text(x0, y, b.merchant, { size: headSize, weight: 700 }));
  y += thermal ? 30 : 42;
  parts.push(text(x0, y, b.category.toUpperCase(), { size: bodySize - 5, fill: '#4a4a46', spacing: thermal ? 0 : 2 }));
  y += thermal ? 16 : 24;
  parts.push(rule(y));
  y += thermal ? 30 : 44;

  for (const li of b.lineItems) {
    parts.push(text(x0, y, li.description));
    parts.push(text(x1, y, money(li.amountCents), { anchor: 'end' }));
    y += lh;
  }

  y += 6;
  parts.push(rule(y));
  y += thermal ? 32 : 44;
  parts.push(text(x0, y, 'Total due', { size: bodySize + 4, weight: 700 }));
  parts.push(text(x1, y, money(b.totalCents), { size: bodySize + 4, weight: 700, anchor: 'end' }));
  y += lh + 8;
  parts.push(text(x0, y, dueLine(b), { size: bodySize - 3, style: 'italic', fill: '#3a3a36' }));
  return { parts, bottom: y + 12 };
}

// Zigzag (torn-off) top and bottom edges for thermal strips.
function zigzagPolygon(W, H, zig) {
  const pts = [];
  const step = 14;
  for (let x = 0, k = 0; x <= W + step; x += step, k++) pts.push([Math.min(x, W), (k % 2) * zig]);
  for (let x = W, k = 0; x >= -step; x -= step, k++) pts.push([Math.max(x, 0), H - (k % 2) * zig]);
  return 'M' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L') + ' Z';
}

function renderBill(b) {
  checkBill(b);
  const st = STYLE[b.photoStyle];
  const thermal = !!st.thermal;
  const W = thermal ? 560 : 860;
  const pad = thermal ? 40 : 64;
  const zig = thermal ? 14 : 0;
  const fam = thermal ? MONO : SANS;

  const { parts, bottom } = paperContent(b, { W, pad, thermal, fam, y0: zig + pad });
  const PW = W;
  const PH = Math.ceil(bottom + pad * 0.8 + zig);
  const margin = st.table ? (thermal ? 80 : 110) : 30;
  const CW = PW + margin * 2;
  const CH = PH + margin * 2;

  const shape = thermal ? zigzagPolygon(PW, PH, zig) : `M0 0 H${PW} V${PH} H0 Z`;
  const shapeEl = (fill, extra = '') => `<path d="${shape}" fill="${fill}" ${extra} />`;

  // Paper placement: centred, rotated and optionally skewed like a phone photo.
  const transform = `translate(${margin + PW / 2} ${margin + PH / 2}) rotate(${st.rot}) skewX(${st.skew}) translate(${-PW / 2} ${-PH / 2})`;

  const rand = rng(parseInt(b.id.replace(/\D/g, ''), 10) * 7919 + 17);
  const folds = [];
  if (st.crumple) {
    for (let i = 0; i < 4; i++) {
      const horizontal = i % 2 === 0;
      const p = 0.15 + rand() * 0.7;
      const x1 = horizontal ? 0 : PW * p;
      const y1 = horizontal ? PH * p : 0;
      const x2 = horizontal ? PW : PW * (p + (rand() - 0.5) * 0.4);
      const y2 = horizontal ? PH * (p + (rand() - 0.5) * 0.4) : PH;
      folds.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#ffffff" stroke-opacity="0.55" stroke-width="3" />`);
      folds.push(`<line x1="${x1 + 3}" y1="${y1 + 3}" x2="${x2 + 3}" y2="${y2 + 3}" stroke="#000" stroke-opacity="0.16" stroke-width="2.5" />`);
    }
  }

  const specks = [];
  for (let i = 0; i < 260; i++) {
    const x = rand() * CW;
    const y = rand() * CH;
    specks.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.6 + rand() * 1.4).toFixed(2)}" fill="#000" fill-opacity="${(0.05 + rand() * 0.12).toFixed(3)}" />`);
  }

  const dimFilter = st.dim < 1
    ? `<filter id="dim" x="-5%" y="-5%" width="110%" height="110%"><feComponentTransfer>` +
      `<feFuncR type="linear" slope="${st.dim}" /><feFuncG type="linear" slope="${st.dim}" /><feFuncB type="linear" slope="${st.dim}" />` +
      `</feComponentTransfer></filter>`
    : '';

  const crumpleFilter = st.crumple
    ? `<filter id="crumple" x="-5%" y="-5%" width="110%" height="110%">` +
      `<feTurbulence type="fractalNoise" baseFrequency="0.03 0.05" numOctaves="2" seed="11" result="n" />` +
      `<feDisplacementMap in="SourceGraphic" in2="n" scale="9" xChannelSelector="R" yChannelSelector="G" /></filter>`
    : '';

  const table = st.table
    ? `<rect width="${CW}" height="${CH}" fill="${st.table}" />` +
      `<rect width="${CW}" height="${CH}" fill="#000" filter="url(#grain)" opacity="0.35" />` +
      `<rect width="${CW}" height="${CH}" fill="url(#light)" />`
    : `<rect width="${CW}" height="${CH}" fill="#ffffff" />`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}" viewBox="0 0 ${CW} ${CH}">
<defs>
  <filter id="grain" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" seed="4" result="t" />
    <feColorMatrix in="t" type="matrix" values="0 0 0 0 0.2  0 0 0 0 0.18  0 0 0 0 0.15  2.6 0 0 0 -0.9" />
  </filter>
  <filter id="soft" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="${st.blur}" /></filter>
  <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="10" /></filter>
  ${crumpleFilter}
  ${dimFilter}
  <radialGradient id="light" cx="45%" cy="40%" r="75%">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.08" />
    <stop offset="1" stop-color="#000000" stop-opacity="0.35" />
  </radialGradient>
  <radialGradient id="vig" cx="50%" cy="45%" r="70%">
    <stop offset="0.45" stop-color="#000" stop-opacity="0" />
    <stop offset="1" stop-color="#000" stop-opacity="0.6" />
  </radialGradient>
  <clipPath id="paper"><path d="${shape}" /></clipPath>
</defs>
${table}
<g transform="${transform}">
  ${st.shadow ? `<g filter="url(#shadow)" opacity="0.45" transform="translate(8 14)">${shapeEl('#000')}</g>` : ''}
  <g ${st.dim < 1 ? 'filter="url(#dim)"' : ''}>
    <g ${st.crumple ? 'filter="url(#crumple)"' : ''}>
      <g ${st.blur > 0 ? 'filter="url(#soft)"' : ''}>
        ${shapeEl(st.paper, 'stroke="#000" stroke-opacity="0.15" stroke-width="2"')}
        <g clip-path="url(#paper)">
          <rect x="-20" y="-20" width="${PW + 40}" height="${PH + 40}" fill="#000" filter="url(#grain)" opacity="${st.grain}" />
          ${parts.join('\n          ')}
          ${folds.join('\n          ')}
          ${st.vignette ? `<rect x="0" y="0" width="${PW}" height="${PH}" fill="url(#vig)" />` : ''}
        </g>
      </g>
    </g>
  </g>
</g>
<g>${specks.join('')}</g>
</svg>`;

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'original' },
    font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica' },
  });
  return { png: resvg.render().asPng(), width: CW, height: CH };
}

const wanted = process.argv.slice(2);
const selected = wanted.length ? bills.filter((b) => wanted.includes(b.id)) : bills;
if (wanted.length && selected.length !== wanted.length) {
  throw new Error(`unknown id(s): ${wanted.filter((id) => !bills.some((b) => b.id === id)).join(', ')}`);
}

await fs.mkdir(outDir, { recursive: true });
for (const b of selected) {
  const { png, width, height } = renderBill(b);
  const file = path.join(outDir, `${b.id}.png`);
  await fs.writeFile(file, png);
  console.log(`${b.id}  ${width}x${height}  ${b.photoStyle}  -> ${file}`);
}
console.log(`rendered ${selected.length} bill(s) to ${outDir}`);
