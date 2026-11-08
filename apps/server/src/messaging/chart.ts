/**
 * Chart PNGs for iMessage (SPEC §6 "Chart images"). Implemented by: tools-code.
 *
 * 1200 x 800, drawn like the dashboard mockup's chart card, rendered from a Forecast with
 * @resvg/resvg-js and IBM Plex Sans bundled as a TTF (pass it in `fontFiles`). Never generated.
 * Title from chartTitleText(), subtitle from chartSubtitleText() (@pacepay/shared templates).
 * Size CHART_PNG and colors COLORS from @pacepay/shared. Date labels under the line: "Today",
 * then short weekday or "Nov 20" style labels from the shared formatter (formatDate pieces).
 * The font: IBM Plex Sans TTFs in apps/server/fixtures/fonts/ (not in the repo yet: fetching them is a
 * download the lead approves). Until they exist, fall back to resvg system fonts (loadSystemFonts).
 */
import type { Forecast, ISODate, Rules } from '@pacepay/shared';

export interface ChartInput {
  forecast: Forecast;
  rules: Rules;
  day0Date: ISODate;
  /** How many days to draw (default 14). */
  days?: number;
  /** Optional ghost line, e.g. "Before" for a what-if chart. */
  ghost?: { forecast: Forecast; label: string };
}

export function renderChartPng(_input: ChartInput): Buffer {
  throw new Error('messaging.renderChartPng: not implemented yet');
}
