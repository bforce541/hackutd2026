'use client';
/**
 * The pace line, as day tiles. Each day is a translucent tile standing on the $0 line: tall and
 * leaf-green when you are safe, shorter and amber near your minimum, and coral hanging below $0
 * when you are overdrawn (also hatched, so color is never the only signal). It is the logo, at
 * scale. Above it: the big balance (it counts up), the status chip, What if and the range switch.
 * Hover or arrow-key along the chart to read any day. Reads state.chart; never computes money.
 * Owned by: dash-paceline.
 */
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { LinePath } from '@visx/shape';
import { curveStepAfter } from '@visx/curve';
import { PatternLines } from '@visx/pattern';
import { CHART_RANGES, formatDate, formatMoney, formatSignedMoney, type Cents } from '@pacepay/shared';
import { Segmented } from '@/components/ui/Segmented';
import { cn } from '@/lib/cn';
import { useTween, useTweenArray, useViewportHeight } from '@/lib/motion';
import { buildGeometry } from '@/lib/pace-line';
import type { DashboardProps } from '@/lib/view-model';

const UP = 'M7 1 L13 12 L1 12 Z';
const DOWN = 'M1 2 L13 2 L7 13 Z';

/** The spectrum, by how safe the day is: coral overdrawn, orange under your minimum, up to leaf. */
function tileColor(v: Cents, floor: Cents): string {
  if (v < 0) return 'var(--coral)';
  if (v < floor) return 'var(--orange)';
  if (v < floor * 8) return 'var(--amber)';
  if (v < floor * 15) return 'var(--lime)';
  return 'var(--leaf)';
}

export function PaceLine({ state, actions }: DashboardProps) {
  const { chart, ui } = state;
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setWidth(Math.round(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fontPx = 12 * (ui.presenter ? 1.25 : 1);
  // The chart gives up height on short screens (Presenter scales everything 25%, so it gives up more).
  const vh = useViewportHeight();
  const chartH = ui.presenter ? Math.max(170, Math.min(300, vh - 590)) : Math.max(220, Math.min(340, Math.round(vh * 0.36)));
  const g = useMemo(
    () =>
      width > 0
        ? buildGeometry({
            width,
            range: ui.range,
            line: chart.line,
            ghost: chart.ghost?.forecast ?? null,
            floor: chart.floor,
            lowestDay: chart.lowest.day,
            day0Date: state.household.day0Date,
            fontPx,
            height: chartH,
          })
        : null,
    [width, ui.range, chart.line, chart.ghost, chart.floor, chart.lowest.day, state.household.day0Date, fontPx, chartH],
  );

  // The tiles glide to new values (what-if, the deal landing, skipping the clock).
  const days = chart.line.days.slice(0, ui.range);
  const shown = useTweenArray(days.map((d) => d.close));
  const balance = useTween(state.household.checkingBalance, { from: 0, ms: 1100 });

  const negative = chart.lowest.amount < 0;
  const below = chart.lowest.amount < chart.floor;
  const day0 = state.household.day0Date;

  // What causes the dip, in words: "Mortgage + Car payment".
  const cause = useMemo(() => {
    const ids = chart.line.lowest.causeItemIds;
    if (!below || ids.length === 0) return null;
    const names: string[] = [];
    for (const id of ids) {
      for (const d of chart.line.days) {
        const it = d.items.find((i) => i.itemId === id);
        if (it) {
          if (!names.includes(it.label)) names.push(it.label);
          break;
        }
      }
    }
    return names.length ? names.join(' + ') : null;
  }, [chart.line, below]);

  const hoverDay = hover !== null ? days[hover] : undefined;

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    if (!g) return;
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * ui.range);
    setHover(Math.max(0, Math.min(ui.range - 1, i)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const step = e.key === 'ArrowRight' ? 1 : -1;
      setHover((h) => Math.max(0, Math.min(ui.range - 1, (h ?? (step > 0 ? -1 : ui.range)) + step)));
    } else if (e.key === 'Escape') setHover(null);
  };

  const calloutW = cause ? cause.length * fontPx * 0.56 + 26 : 0;

  // The cause callout takes the first spot near the dot that stays inside the chart and clear of
  // every date label; if there is none, the status chip and the hover card still say it.
  const calloutAt = useMemo(() => {
    if (!g?.low || !cause) return null;
    const { x, y } = g.low;
    const h = 24;
    const tries: [number, number][] = [
      [x - calloutW / 2, y + 14],
      [x - calloutW / 2, y - 14 - h],
      [x + 14, y - h / 2],
      [x - 14 - calloutW, y - h / 2],
      [x - calloutW / 2, y + 14 + h + 6],
    ];
    for (const [cx, cy] of tries) {
      const left = Math.max(0, Math.min(width - calloutW, cx));
      const box = { x0: left - 4, x1: left + calloutW + 4, y0: cy - 4, y1: cy + h + 4 };
      if (box.y0 < 0 || box.y1 > chartH) continue;
      const hit = g.labels.some((l) => l.x < box.x1 && l.x + l.w > box.x0 && l.y < box.y1 && l.y + l.h > box.y0);
      if (!hit) return { x: left, y: cy };
    }
    return null;
  }, [g, cause, calloutW, width, chartH]);

  return (
    <section
      aria-label="Checking forecast"
      className="rise flex min-w-0 flex-col rounded-[1.75rem] border border-hairline bg-panel p-6 shadow-panel sm:p-7 [html[data-presenter=true]_&]:p-5"
      style={{ '--d': '80ms' } as CSSProperties}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <p className="eyebrow text-muted">Checking · next {ui.range} days</p>
          <p className="display num mt-2 text-hero">{formatMoney(Math.round(balance))}</p>
          <p
            className={cn(
              'mt-3 inline-flex max-w-full items-center gap-2 rounded-full px-3 py-1.5 text-label font-medium',
              negative ? 'bg-vermilion-tint text-vermilion' : below ? 'bg-secondary-hover text-ochre' : 'bg-green-tint text-green',
            )}
          >
            <svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true" className="flex-none" fill="currentColor">
              <path d={negative || below ? DOWN : UP} />
            </svg>
            <span className="truncate">{chart.status}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!state.call && (
            <button
              type="button"
              aria-pressed={ui.whatIfOpen}
              onClick={actions.toggleWhatIf}
              className={cn(
                'min-h-9 rounded-full border px-4 text-label font-medium transition-[background-color,transform,border-color] duration-[var(--dur-base)] active:scale-[0.97]',
                ui.whatIfOpen ? 'border-ink bg-ink text-page' : 'border-hairline bg-panel text-ink hover:bg-secondary-hover',
              )}
            >
              What if
            </button>
          )}
          <Segmented
            kind="toggle"
            size="sm"
            label="Forecast range"
            options={CHART_RANGES.map((r) => ({ value: r, label: `${r}d`, name: `${r} days` }))}
            value={ui.range}
            onChange={actions.setRange}
          />
        </div>
      </div>

      <div
        ref={wrap}
        tabIndex={0}
        role="group"
        aria-label="Daily balance. Use the left and right arrow keys to read each day."
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
        className="relative mb-9 mr-12 mt-6 rounded-lg [html[data-presenter=true]_&]:mb-8 [html[data-presenter=true]_&]:mt-3"
        style={{ height: chartH }}
      >
        {g && (
          <svg
            role="img"
            aria-label={`Checking balance forecast. ${chart.status}.`}
            width={width}
            height={chartH}
            className="absolute left-0 top-0 overflow-visible"
          >
            <defs>
              <PatternLines id="pp-hatch" height={6} width={6} orientation={['diagonal']} stroke="var(--hatch)" strokeWidth={1.25} />
            </defs>

            {/* Day columns: a hairline per week, so the tiles read as a calendar */}
            {Array.from({ length: ui.range + 1 }, (_, i) => i)
              .filter((i) => (ui.range <= 14 ? true : i % 7 === 0))
              .map((i) => (
                <line key={i} x1={i * g.colW} x2={i * g.colW} y1={0} y2={chartH} style={{ stroke: 'var(--grid)' }} strokeWidth={1} />
              ))}

            {g.grid.map((l) => (
              <g key={l.label}>
                <line
                  x1={0}
                  x2={width}
                  y1={l.y}
                  y2={l.y}
                  style={{ stroke: l.zero ? 'var(--ink)' : 'var(--grid)', strokeOpacity: l.zero ? 0.5 : 1 }}
                  strokeWidth={l.zero ? 1.5 : 1}
                />
                <text
                  x={width + 12}
                  y={l.y}
                  dominantBaseline="central"
                  fontSize={fontPx - 1}
                  fontWeight={l.zero ? 600 : 400}
                  style={{ fill: l.zero ? 'var(--ink)' : 'var(--muted)', fontFamily: 'var(--font-mono)' }}
                >
                  {l.label}
                </text>
              </g>
            ))}

            {/* The tiles. Positive stand on the $0 line, negative hang from it. */}
            {days.map((d, i) => {
              const v = shown[i] ?? d.close;
              const col = tileColor(d.close, chart.floor);
              const yv = g.y(v);
              const up = v >= 0;
              const h = Math.max(Math.abs(yv - g.zeroY), 3);
              const top = up ? g.zeroY - h : g.zeroY;
              const gap = Math.max(1, Math.min(3, g.colW * 0.1));
              const x = i * g.colW + gap;
              const w = Math.max(2, g.colW - gap * 2);
              const rx = Math.min(6, w / 3);
              const dim = hover !== null && hover !== i;
              // Colors ease over, left to right, so a deal landing reads as a wave of green
              const wave = `fill 650ms var(--ease-std) ${i * 40}ms`;
              const grow: CSSProperties = {
                transformBox: 'fill-box',
                transformOrigin: up ? 'bottom' : 'top',
                animation: `tile-grow 800ms var(--ease-out) ${60 + i * 24}ms both`,
                opacity: dim ? 0.55 : 1,
                transition: 'opacity 160ms var(--ease-std)',
              };
              return (
                <g key={i} style={grow} aria-hidden="true">
                  <rect x={x} y={top} width={w} height={h} rx={rx} style={{ fill: col, fillOpacity: 'var(--tile-a)', transition: wave }} />
                  {d.close < 0 && <rect x={x} y={top} width={w} height={h} rx={rx} fill="url(#pp-hatch)" opacity={0.55} />}
                  <rect x={x} y={up ? top : top + h - 3} width={w} height={3} rx={1.5} style={{ fill: col, transition: wave }} />
                </g>
              );
            })}

            <line
              x1={0}
              x2={width}
              y1={g.floorY}
              y2={g.floorY}
              strokeWidth={1.5}
              strokeDasharray="5 5"
              style={{ stroke: 'var(--ochre-line)' }}
            />

            {g.ghost.length > 0 && (
              <LinePath
                data={g.ghost}
                x={(p) => p.x}
                y={(p) => p.y}
                curve={curveStepAfter}
                fill="none"
                strokeWidth={2}
                strokeDasharray="6 5"
                style={{ stroke: 'var(--before-line)' }}
              />
            )}

            {g.markers.map((m) => (
              <g
                key={m.key}
                transform={`translate(${m.cx - 5} ${m.cy - 5}) scale(${10 / 14})`}
                style={{ fill: m.up ? 'var(--leaf)' : 'var(--zero-line)' }}
              >
                <title>{m.title}</title>
                <path d={m.up ? UP : DOWN} />
              </g>
            ))}

            {g.labels.map((lb) => (
              <g key={lb.key} aria-hidden="true">
                <rect x={lb.x} y={lb.y} width={lb.w} height={lb.h} rx={lb.h / 2} style={{ fill: 'var(--panel)', stroke: 'var(--hairline)' }} />
                <text
                  x={lb.x + lb.w / 2}
                  y={lb.y + lb.h / 2}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={fontPx}
                  fontWeight={500}
                  style={{ fill: 'var(--label-ink)' }}
                >
                  {lb.text}
                </text>
              </g>
            ))}

            {/* The lowest point: a dot, a pulse that plays twice, and what caused it */}
            {g.low && (
              <g aria-hidden="true">
                <circle
                  cx={g.low.x}
                  cy={g.low.y}
                  r={5}
                  style={{
                    fill: g.low.negative ? 'var(--coral)' : 'var(--amber)',
                    transformBox: 'fill-box',
                    transformOrigin: 'center',
                    animation: 'ring 1.7s var(--ease-out) 1.1s 2 both',
                    opacity: 0,
                  }}
                />
                <circle
                  cx={g.low.x}
                  cy={g.low.y}
                  r={5.5}
                  strokeWidth={3}
                  style={{ fill: g.low.negative ? 'var(--coral)' : 'var(--amber)', stroke: 'var(--panel)' }}
                />
                {cause && calloutAt && (
                  <g className="fade-in" style={{ '--d': '900ms' } as CSSProperties} transform={`translate(${calloutAt.x} ${calloutAt.y})`}>
                    <rect width={calloutW} height={24} rx={12} style={{ fill: 'var(--panel)', stroke: 'var(--hairline)' }} />
                    <text
                      x={calloutW / 2}
                      y={12.5}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={fontPx}
                      fontWeight={500}
                      style={{ fill: 'var(--label-ink)' }}
                    >
                      {cause}
                    </text>
                  </g>
                )}
              </g>
            )}

            {g.ticks.map((t) => (
              <text
                key={t.label + t.x}
                x={t.x}
                y={chartH + 12 + fontPx}
                textAnchor={t.anchor}
                fontSize={fontPx}
                style={{ fill: 'var(--muted)' }}
              >
                {t.label}
              </text>
            ))}

            {/* Scrub: the column under the pointer (or the arrow keys) */}
            {hover !== null && (
              <rect
                x={hover * g.colW}
                y={0}
                width={g.colW}
                height={chartH}
                rx={6}
                style={{ fill: 'var(--ink)', fillOpacity: 0.05, stroke: 'var(--ink)', strokeOpacity: 0.25 }}
                pointerEvents="none"
              />
            )}
            <rect
              x={0}
              y={0}
              width={width}
              height={chartH}
              fill="transparent"
              style={{ touchAction: 'pan-y' }}
              onPointerMove={onMove}
              onPointerDown={onMove}
              onPointerLeave={() => setHover(null)}
            />
          </svg>
        )}

        {g && hoverDay && hover !== null && (
          <div
            role="status"
            className="num pointer-events-none absolute top-0 z-10 w-52 rounded-2xl border border-hairline bg-panel p-3.5 shadow-panel"
            style={{
              left: Math.max(0, Math.min(width - 208, hover * g.colW + g.colW / 2 - 104)),
              transform: 'translateY(-6px)',
              animation: 'fade 140ms var(--ease-std) both',
            }}
          >
            <p className="eyebrow text-muted">{formatDate(hoverDay.day, day0)}</p>
            <p className="display mt-1 text-[1.625rem]">{formatMoney(hoverDay.close)}</p>
            {hoverDay.intradayLow < hoverDay.close && (
              <p className="mt-1 text-chart text-vermilion">Dips to {formatMoney(hoverDay.intradayLow)} that day</p>
            )}
            {hoverDay.items.length > 0 && (
              <ul className="m-0 mt-2.5 list-none space-y-1 border-t border-hairline p-0 pt-2.5 text-chart">
                {hoverDay.items.map((it, k) => (
                  <li key={`${it.itemId}-${k}`} className="flex justify-between gap-3">
                    <span className="truncate text-muted">{it.label}</span>
                    <span className={cn('flex-none font-medium', it.amount > 0 ? 'text-green' : 'text-ink')}>{formatSignedMoney(it.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <ul aria-label="Chart key" className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1.5 p-0 text-chart text-muted">
        <li className="flex items-center gap-1.5">
          <svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true">
            <path d={UP} style={{ fill: 'var(--leaf)' }} />
          </svg>
          Pay
        </li>
        <li className="flex items-center gap-1.5">
          <svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true">
            <path d={DOWN} style={{ fill: 'var(--zero-line)' }} />
          </svg>
          Bill
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="w-5 border-t-[1.5px] border-dashed" style={{ borderColor: 'var(--ochre-line)' }} />
          {formatMoney(chart.floor)} minimum
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="flex gap-[2px]">
            {['var(--coral)', 'var(--orange)', 'var(--amber)', 'var(--lime)', 'var(--leaf)'].map((c) => (
              <span key={c} className="h-3 w-2 rounded-[2px]" style={{ background: c }} />
            ))}
          </span>
          Overdrawn to safe
        </li>
        {chart.ghost && (
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="w-5 border-t-2 border-dashed" style={{ borderColor: 'var(--before-line)' }} />
            {chart.ghost.label}
          </li>
        )}
      </ul>
    </section>
  );
}
