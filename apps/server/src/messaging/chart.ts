/**
 * Chart PNGs for iMessage (SPEC §6 "Chart images"). Implemented by: tools-code.
 *
 * 1200 x 800, drawn like the dashboard mockup's chart card (design/mockup/Phone.dc.html), rendered
 * from a Forecast with @resvg/resvg-js and the bundled IBM Plex Sans TTFs (assets/fonts, OFL).
 * Title and subtitle come from the shared templates; size and colors from CHART_PNG and COLORS.
 * Built from engine data, never generated.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import {
  CHART_PNG,
  COLORS,
  chartSubtitleText,
  chartTitleText,
  formatShortDate,
  weekdayOf,
  type Forecast,
  type ISODate,
  type Rules,
} from '@pacepay/shared';

export interface ChartInput {
  forecast: Forecast;
  rules: Rules;
  day0Date: ISODate;
  /** How many days to draw (default 14). */
  days?: number;
  /** Optional ghost line, e.g. "Before" for a what-if chart. */
  ghost?: { forecast: Forecast; label: string };
}

const FONT_DIR = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));
const FONT_FILES = ['IBMPlexSans-Regular.ttf', 'IBMPlexSans-Medium.ttf', 'IBMPlexSans-SemiBold.ttf']
  .map((f) => FONT_DIR + f)
  .filter((f) => existsSync(f));

const FONT = "'IBM Plex Sans', sans-serif";
const W = CHART_PNG.width;
const H = CHART_PNG.height;
const PAD_X = 72;
const PLOT_TOP = 262;
const PLOT_BOTTOM = 612;
const LABEL_Y = 690;
const DOT_R = 15;

const n2 = (v: number): string => v.toFixed(2);
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderChartPng(input: ChartInput): Buffer {
  return Buffer.from(new Resvg(chartSvg(input), {
    fitTo: { mode: 'width', value: W },
    font: FONT_FILES.length ? { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'IBM Plex Sans' } : { loadSystemFonts: true },
  }).render().asPng());
}

export function chartSvg(input: ChartInput): string {
  const n = Math.min(input.days ?? CHART_PNG.days, input.forecast.days.length);
  if (n < 1) throw new Error('renderChartPng: the forecast has no days');
  const days = input.forecast.days.slice(0, n);
  const today = days[0]!.day;
  const ghostDays = input.ghost?.forecast.days.slice(0, n);
  const closes = days.map((d) => d.close);
  const ghostCloses = ghostDays?.map((d) => d.close) ?? [];

  // Lowest of what is drawn (what the title says), so a short window stays consistent.
  const lowest = days.reduce((m, d) => (d.close < m.amount ? { amount: d.close, day: d.day } : m), { amount: days[0]!.close, day: today });
  const shown = input.days === undefined || n === input.forecast.days.length ? input.forecast.lowest : lowest;
  const low = days.some((d) => d.day === shown.day) ? { amount: shown.amount, day: shown.day } : lowest;

  const vals = [...closes, ...ghostCloses, low.amount, 0];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi === lo) hi = lo + 1;
  const y = (c: number): number => PLOT_BOTTOM - ((c - lo) / (hi - lo)) * (PLOT_BOTTOM - PLOT_TOP);
  const plotW = W - 2 * PAD_X;
  const colW = plotW / n;
  const x = (i: number): number => PAD_X + i * colW;
  const zeroY = y(0);

  const step = (cs: number[]): string => {
    let d = `M${n2(x(0))},${n2(y(cs[0]!))}`;
    cs.forEach((c, i) => {
      d += ` L${n2(x(i + 1))},${n2(y(c))}`;
      const next = cs[i + 1];
      if (next !== undefined) d += ` L${n2(x(i + 1))},${n2(y(next))}`;
    });
    return d;
  };

  const hatch = days
    .map((d, i) => (d.close < 0 ? `<rect x="${n2(x(i))}" y="${n2(zeroY)}" width="${n2(colW)}" height="${n2(y(d.close) - zeroY)}" fill="url(#hatch)"/>` : ''))
    .join('');

  // Date labels: Today, the lowest day, the next paycheck (first credit after it), the last day.
  const labelAt = (i: number): string => {
    const day = days[i]!.day;
    if (i === 0) return 'Today';
    return day - today < 7 ? weekdayOf(day, input.day0Date) : formatShortDate(day, input.day0Date);
  };
  const lowIdx = days.findIndex((d) => d.day === low.day);
  const recoverIdx = days.findIndex((d, i) => i > lowIdx && d.items.some((it) => it.amount > 0));
  const wanted = [lowIdx, recoverIdx].filter((i) => i > 0 && i < n - 1);
  const placed: { i: number; cx: number; text: string }[] = [{ i: 0, cx: PAD_X + 40, text: labelAt(0) }];
  const lastText = labelAt(n - 1);
  const lastCx = W - PAD_X - lastText.length * 8;
  for (const i of [...new Set(wanted)].sort((a, b) => a - b)) {
    const cx = x(i) + colW / 2;
    if (placed.every((p) => Math.abs(p.cx - cx) >= 120) && Math.abs(lastCx - cx) >= 120) placed.push({ i, cx, text: labelAt(i) });
  }
  const labels =
    placed
      .map((p, k) =>
        k === 0
          ? `<text x="${PAD_X}" y="${LABEL_Y}" font-size="30" fill="${COLORS.muted}">${esc(p.text)}</text>`
          : `<text x="${n2(p.cx)}" y="${LABEL_Y}" font-size="30" fill="${COLORS.muted}" text-anchor="middle">${esc(p.text)}</text>`,
      )
      .join('') + (n > 1 ? `<text x="${W - PAD_X}" y="${LABEL_Y}" font-size="30" fill="${COLORS.muted}" text-anchor="end">${esc(lastText)}</text>` : '');

  const ghost = input.ghost
    ? `<path d="${step(ghostCloses)}" fill="none" stroke="${COLORS.beforeLine}" stroke-width="5" stroke-dasharray="16 12" stroke-linejoin="round"/>` +
      `<line x1="${W - PAD_X - 220}" y1="110" x2="${W - PAD_X - 160}" y2="110" stroke="${COLORS.beforeLine}" stroke-width="5" stroke-dasharray="14 10"/>` +
      `<text x="${W - PAD_X - 146}" y="121" font-size="30" fill="${COLORS.muted}">${esc(input.ghost.label)}</text>`
    : '';

  const title = chartTitleText({ lowest: { amount: low.amount, day: low.day }, day0Date: input.day0Date });
  const dotX = x(lowIdx) + colW / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
<defs><pattern id="hatch" width="18" height="18" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="18" height="18" fill="${COLORS.hatchBg}"/><line x1="0" y1="0" x2="0" y2="18" stroke="${COLORS.hatch}" stroke-width="4.6"/></pattern></defs>
<rect width="${W}" height="${H}" fill="${COLORS.page}"/>
<text x="${PAD_X}" y="130" font-size="52" font-weight="600" fill="${COLORS.ink}">${esc(title)}</text>
<text x="${PAD_X}" y="184" font-size="32" fill="${COLORS.muted}">${esc(chartSubtitleText(n))}</text>
${hatch}
<line x1="${PAD_X}" y1="${n2(zeroY)}" x2="${W - PAD_X}" y2="${n2(zeroY)}" stroke="${COLORS.zeroLine}" stroke-width="4"/>
${ghost}
<path d="${step(closes)}" fill="none" stroke="${COLORS.green}" stroke-width="8" stroke-linejoin="round"/>
<circle cx="${n2(dotX)}" cy="${n2(y(low.amount))}" r="${DOT_R}" fill="${COLORS.vermilion}" stroke="${COLORS.page}" stroke-width="5"/>
${labels}
</svg>`;
}
