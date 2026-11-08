'use client';
/**
 * The pace line (UI.md "The pace line"), built with visx: stepped line (curveStepAfter), $0 as
 * the heaviest gridline, dashed ochre minimum, hatching below $0 only, paycheck and bill markers
 * with labels that never cover a line, a dot on the lowest point, the gray dashed ghost line,
 * axis labels on the right, and above it the balance, status line, What if and range switch.
 * Owned by: dash-paceline. Reads state.chart; never computes balances itself.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LinePath } from '@visx/shape';
import { curveStepAfter } from '@visx/curve';
import { PatternLines } from '@visx/pattern';
import { CHART_RANGES, formatMoney } from '@pacepay/shared';
import { cn } from '@/lib/cn';
import { buildGeometry, CHART_H } from '@/lib/pace-line';
import type { DashboardProps } from '@/lib/view-model';

const UP = 'M7 1 L13 12 L1 12 Z';
const DOWN = 'M1 2 L13 2 L7 13 Z';

export function PaceLine({ state, actions }: DashboardProps) {
  const { chart, ui } = state;
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setWidth(Math.round(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fontPx = 13 * (ui.presenter ? 1.25 : 1);
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
          })
        : null,
    [width, ui.range, chart.line, chart.ghost, chart.floor, chart.lowest.day, state.household.day0Date, fontPx],
  );

  const negative = chart.lowest.amount < 0;

  return (
    <section aria-label="Checking forecast" className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <p className="text-label text-muted">Checking</p>
          <p className="num mt-0.5 text-hero font-medium leading-[1.1] tracking-[-0.02em]">
            {formatMoney(state.household.checkingBalance)}
          </p>
          <p className="mt-2.5 flex items-center gap-2 text-[0.9375rem]">
            {negative ? (
              <span
                aria-hidden="true"
                className="inline-block size-3.5 flex-none rounded-[2px]"
                style={{ background: 'repeating-linear-gradient(45deg, var(--hatch) 0 1.5px, var(--hatch-bg) 1.5px 4.5px)' }}
              />
            ) : (
              <span aria-hidden="true" className="inline-block size-2.5 flex-none rounded-full bg-green" />
            )}
            <span>{chart.status}</span>
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-x-7 gap-y-2">
          {!state.call && (
            <button
              type="button"
              aria-pressed={ui.whatIfOpen}
              onClick={actions.toggleWhatIf}
              className={cn(
                'min-h-10 cursor-pointer rounded-lg border px-3.5 text-label font-semibold',
                ui.whatIfOpen ? 'border-green bg-green-tint text-green' : 'border-[#cfccc4] bg-panel text-ink',
              )}
            >
              What if
            </button>
          )}
          <div role="group" aria-label="Forecast range" className="flex items-center gap-5">
            <span className="text-label text-muted">Next</span>
            {CHART_RANGES.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={ui.range === r}
                onClick={() => actions.setRange(r)}
                className={cn(
                  'min-h-11 cursor-pointer px-0.5 text-label',
                  ui.range === r
                    ? 'font-semibold text-ink underline decoration-green decoration-2 underline-offset-[0.45em]'
                    : 'font-medium text-muted',
                )}
              >
                {r} days
              </button>
            ))}
          </div>
        </div>
      </div>

      <div ref={wrap} className="relative mb-9 mr-14 mt-6" style={{ height: CHART_H }}>
        {g && (
          <svg
            role="img"
            aria-label={`Checking balance forecast. ${chart.status}.`}
            width={width}
            height={CHART_H}
            className="absolute left-0 top-0 overflow-visible"
          >
            <defs>
              <PatternLines
                id="pp-hatch"
                height={7}
                width={7}
                orientation={['diagonal']}
                stroke="var(--hatch)"
                strokeWidth={1.75}
                background="var(--hatch-bg)"
              />
              <clipPath id="pp-below-zero">
                <rect x={0} y={g.zeroY} width={width} height={CHART_H - g.zeroY + 40} />
              </clipPath>
            </defs>

            {g.grid.map((l) => (
              <g key={l.label}>
                <line
                  x1={0}
                  x2={width}
                  y1={l.y}
                  y2={l.y}
                  style={{ stroke: l.zero ? 'var(--zero-line)' : 'var(--grid)' }}
                  strokeWidth={l.zero ? 1.5 : 1}
                />
                <text
                  x={width + 12}
                  y={l.y}
                  dominantBaseline="central"
                  fontSize={fontPx}
                  fontWeight={l.zero ? 600 : 400}
                  style={{ fill: l.zero ? 'var(--ink)' : 'var(--muted)' }}
                >
                  {l.label}
                </text>
              </g>
            ))}

            <line
              x1={0}
              x2={width}
              y1={g.floorY}
              y2={g.floorY}
              strokeWidth={1.5}
              strokeDasharray="6 4"
              style={{ stroke: 'var(--ochre-line)' }}
            />

            <polygon points={g.zeroArea} fill="url(#pp-hatch)" clipPath="url(#pp-below-zero)" />

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
            <LinePath
              data={g.line}
              x={(p) => p.x}
              y={(p) => p.y}
              curve={curveStepAfter}
              fill="none"
              strokeWidth={2.5}
              strokeLinejoin="round"
              style={{ stroke: 'var(--green)' }}
            />

            {g.markers.map((m) => (
              <g
                key={m.key}
                tabIndex={0}
                transform={`translate(${m.cx - 6} ${m.cy - 6}) scale(${12 / 14})`}
                className="outline-offset-2 focus-visible:outline focus-visible:outline-2"
                style={{ fill: m.up ? 'var(--green)' : 'var(--zero-line)' }}
              >
                <title>{m.title}</title>
                <path d={m.up ? UP : DOWN} />
              </g>
            ))}

            {g.low && (
              <circle
                cx={g.low.x}
                cy={g.low.y}
                r={3.75}
                strokeWidth={2.5}
                aria-hidden="true"
                style={{
                  fill: g.low.negative ? 'var(--vermilion)' : 'var(--green)',
                  stroke: 'var(--page)',
                }}
              />
            )}
            {g.low && (
              <circle
                cx={g.low.x}
                cy={g.low.y}
                r={6.25}
                fill="none"
                strokeWidth={1.5}
                aria-hidden="true"
                style={{ stroke: g.low.negative ? 'var(--vermilion)' : 'var(--green)' }}
              />
            )}

            {g.labels.map((lb) => (
              <g key={lb.key} aria-hidden="true">
                <rect x={lb.x} y={lb.y} width={lb.w} height={lb.h} rx={4} fill="rgba(242, 241, 237, 0.92)" />
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

            {g.ticks.map((t) => (
              <text
                key={t.label + t.x}
                x={t.x}
                y={CHART_H + 10 + fontPx}
                textAnchor={t.anchor}
                fontSize={fontPx}
                style={{ fill: 'var(--muted)' }}
              >
                {t.label}
              </text>
            ))}
          </svg>
        )}
      </div>

      <ul aria-label="Chart key" className="m-0 flex list-none flex-wrap gap-x-6 gap-y-1 p-0 text-chart text-muted">
        <li className="flex items-center gap-1.5">
          <svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true">
            <path d={UP} style={{ fill: 'var(--green)' }} />
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
          <span
            aria-hidden="true"
            className="h-3 w-3.5 rounded-[2px]"
            style={{ background: 'repeating-linear-gradient(45deg, var(--hatch) 0 1.5px, var(--hatch-bg) 1.5px 4.5px)' }}
          />
          Overdrawn
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
