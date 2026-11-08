/**
 * Geometry for the pace line: scales, step points, markers and the label placement ported from
 * the mockup's renderVals(). Pure layout: it takes balances the data source already computed and
 * never works out money. Owned by: dash-paceline.
 */
import { formatAxisMoney, formatSignedMoney, formatShortDate, type Cents, type Forecast, type ISODate } from '@pacepay/shared';

export const CHART_H = 300;
const PAD = 10;

export interface Pt {
  x: number;
  y: number;
}
export interface Marker {
  key: string;
  up: boolean;
  cx: number; // marker center x
  cy: number; // marker center y
  title: string;
}
export interface LabelBox {
  key: string;
  text: string;
  x: number; // left edge
  y: number; // top edge
  w: number;
  h: number;
}
export interface GridLine {
  y: number;
  label: string;
  zero: boolean;
}
export interface Tick {
  x: number;
  label: string;
  anchor: 'start' | 'middle';
}

export interface ChartGeometry {
  n: number;
  line: Pt[]; // one point per day plus the end, for curveStepAfter
  ghost: Pt[]; // empty when none
  zeroArea: string;
  zeroY: number;
  floorY: number;
  grid: GridLine[];
  ticks: Tick[];
  markers: Marker[];
  labels: LabelBox[];
  low: { x: number; y: number; negative: boolean } | null;
  /** Value (cents) to chart y: the day tiles are drawn through the same scale as everything else. */
  y: (v: number) => number;
  /** Width of one day's column. */
  colW: number;
  /** Each day's closing balance, the value its tile shows. */
  closes: number[];
}

export interface GeometryInput {
  width: number;
  range: number;
  line: Forecast;
  ghost: Forecast | null;
  floor: Cents;
  lowestDay: number;
  day0Date: ISODate;
  fontPx: number;
  /** Chart height in px; defaults to CHART_H. The page shrinks it on short screens. */
  height?: number;
}

type Short = 'Pay' | 'Mortgage' | 'Car';

/** Which of the three labeled items an engine item is (by id first, then by its label). */
function shortOf(itemId: string, label: string): Short | null {
  const id = itemId.toLowerCase();
  const l = label.toLowerCase();
  if (id.startsWith('paycheck') || l.startsWith('paycheck')) return 'Pay';
  if (id.startsWith('mortgage') || l.startsWith('mortgage')) return 'Mortgage';
  if (id.startsWith('auto_payment') || id.startsWith('car_payment') || l.startsWith('car payment')) return 'Car';
  return null;
}

function isFee(itemId: string, label: string): boolean {
  return itemId.toLowerCase().startsWith('fee') || /\bfee\b/i.test(label);
}

export function buildGeometry(inp: GeometryInput): ChartGeometry {
  const n = inp.range;
  const W = inp.width;
  const H = inp.height ?? CHART_H;
  const days = inp.line.days.slice(0, n);
  const bal = days.map((d) => d.close);
  const ghostBal = inp.ghost ? inp.ghost.days.slice(0, n).map((d) => d.close) : [];
  const lows = days.map((d) => d.intradayLow);
  const all = [...bal, ...lows, ...ghostBal];

  const top = Math.ceil((Math.max(...all, 0) + 30000) / 100000) * 100000;
  const bot = Math.min(-100000, Math.floor((Math.min(...all, 0) - 30000) / 50000) * 50000);
  const y = (v: number) => PAD + ((top - v) / (top - bot)) * (H - 2 * PAD);
  const px = (i: number) => (i / n) * W;

  const stepPts = (arr: number[]): string => {
    const p: string[] = [];
    arr.forEach((v, i) => {
      const yy = y(v).toFixed(1);
      p.push(`${px(i).toFixed(1)},${yy}`, `${px(i + 1).toFixed(1)},${yy}`);
    });
    return p.join(' ');
  };
  const line = stepPts(bal);
  const zeroY = y(0);
  const stepData = (arr: number[]): Pt[] =>
    arr.length ? [...arr.map((v, i) => ({ x: px(i), y: y(v) })), { x: px(arr.length), y: y(arr[arr.length - 1]) }] : [];

  const grid: GridLine[] = [];
  for (let v = Math.floor(top / 100000) * 100000; v >= bot; v -= 100000) {
    grid.push({ y: y(v), label: formatAxisMoney(v), zero: v === 0 });
  }

  // Collision model: every line segment of both lines, plus boxes already placed.
  const lh = inp.fontPx * 1.5;
  type Seg = { h: boolean; a: number; b: number; c: number };
  const segs: Seg[] = [];
  const addLine = (arr: number[]) => {
    arr.forEach((v, i) => {
      segs.push({ h: true, a: px(i), b: px(i + 1), c: y(v) });
      if (i > 0 && v !== arr[i - 1]) {
        segs.push({ h: false, a: Math.min(y(arr[i - 1]), y(v)), b: Math.max(y(arr[i - 1]), y(v)), c: px(i) });
      }
    });
  };
  addLine(bal);
  if (ghostBal.length) addLine(ghostBal);
  const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const blocked = (r: { x0: number; x1: number; y0: number; y1: number }) => {
    if (r.x0 < 0 || r.x1 > W || r.y0 < 0 || r.y1 > H) return true;
    for (const s of segs) {
      if (s.h) {
        if (s.c >= r.y0 - 3 && s.c <= r.y1 + 3 && s.b > r.x0 && s.a < r.x1) return true;
      } else if (s.c >= r.x0 - 3 && s.c <= r.x1 + 3 && s.b > r.y0 && s.a < r.y1) {
        return true;
      }
    }
    return boxes.some((o) => o.x1 > r.x0 && o.x0 < r.x1 && o.y1 > r.y0 && o.y0 < r.y1);
  };

  // The lowest point is the day's intraday low (debits post before credits), which can sit below
  // that day's closing step. Use the named day when it is in view, else the lowest visible day.
  let loIdx = days.findIndex((d) => d.day === inp.lowestDay);
  if (loIdx < 0 && lows.length) loIdx = lows.indexOf(Math.min(...lows));
  let low: ChartGeometry['low'] = null;
  if (loIdx >= 0) {
    const lx = ((loIdx + 0.5) / n) * W;
    const lowAmount = lows[loIdx];
    const ly = y(lowAmount);
    low = { x: lx, y: ly, negative: lowAmount < 0 };
    boxes.push({ x0: lx - 8, x1: lx + 8, y0: ly - 8, y1: ly + 8 });
  }

  // Markers: every posting after today, fees skipped. Label only the first Pay, Mortgage and Car.
  const markers: Marker[] = [];
  const queue: { text: string; rel: number; up: boolean; key: string }[] = [];
  const labeled = new Set<Short>();
  days.forEach((d, rel) => {
    if (rel === 0) return;
    d.items.forEach((it, k) => {
      if (isFee(it.itemId, it.label)) return;
      const up = it.amount > 0;
      const yy = y(bal[rel]);
      const cx = ((rel + 0.5) / n) * W;
      const key = `${rel}-${it.itemId}-${k}`;
      if (up || rel !== loIdx) {
        const cy = up ? yy - 10 : yy + 9;
        boxes.push({ x0: cx - 7, x1: cx + 7, y0: cy - 7, y1: cy + 7 });
        markers.push({
          key,
          up,
          cx,
          cy: up ? yy - 8.4 : yy + 8.4,
          title: `${it.label} ${formatSignedMoney(it.amount)}, ${formatShortDate(d.day, inp.day0Date)}`,
        });
      }
      const s = shortOf(it.itemId, it.label);
      if (s && !labeled.has(s)) {
        labeled.add(s);
        queue.push({ text: `${formatSignedMoney(it.amount)} ${s}`, rel, up, key });
      }
    });
  });

  const labels: LabelBox[] = [];
  for (const q of queue) {
    const w = q.text.length * inp.fontPx * 0.58 + inp.fontPx * 0.6;
    const yPrev = y(bal[q.rel - 1]);
    const yNew = y(bal[q.rel]);
    const hi = Math.min(yPrev, yNew);
    const lo = Math.max(yPrev, yNew);
    const xs = (q.rel / n) * W;
    const xc = ((q.rel + 0.5) / n) * W;
    const als = ['center', 'left', 'right'] as const;
    const cands: { ax: number; al: (typeof als)[number]; top: number }[] = [];
    als.forEach((al) => cands.push({ ax: q.up ? xc : xs, al, top: hi - 6 - lh - (q.up ? 12 : 0) }));
    als.forEach((al) => cands.push({ ax: xc, al, top: lo + 6 + (q.up ? 0 : 14) }));
    for (const c of cands) {
      const x0 = c.al === 'center' ? c.ax - w / 2 : c.al === 'left' ? c.ax : c.ax - w;
      const r = { x0, x1: x0 + w, y0: c.top, y1: c.top + lh };
      if (!blocked(r)) {
        boxes.push(r);
        labels.push({ key: q.key, text: q.text, x: x0, y: c.top, w, h: lh });
        break;
      }
    }
  }

  // Widen the step on narrow charts so neighbouring date labels never touch.
  let tickStep = n <= 14 ? 3 : n <= 30 ? 7 : 14;
  while ((tickStep / n) * W < inp.fontPx * 6.2 && tickStep < n) tickStep += n <= 14 ? 1 : 7;
  const ticks: Tick[] = [];
  for (let d = 0; d < n && d < days.length; d += tickStep) {
    ticks.push({
      x: (d / n) * W,
      label: d === 0 ? 'Today' : formatShortDate(days[d].day, inp.day0Date),
      anchor: d === 0 ? 'start' : 'middle',
    });
  }

  return {
    n,
    line: stepData(bal),
    ghost: stepData(ghostBal),
    zeroArea: `${line} ${W},${zeroY.toFixed(1)} 0,${zeroY.toFixed(1)}`,
    zeroY,
    floorY: y(inp.floor),
    grid,
    ticks,
    markers,
    labels,
    low,
    y,
    colW: W / n,
    closes: bal,
  };
}
