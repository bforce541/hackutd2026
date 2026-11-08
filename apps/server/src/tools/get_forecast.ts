/**
 * Tool `get_forecast` (SPEC §5.6). Implemented by: tools-code.
 * Numbers come from ../forecast.ts (currentForecast, currentScores) so they match GET /api/forecast.
 * Days default to the 14 the chart shows; items are compacted to label and amount.
 */
import { CHART_PNG, TOOLS } from '@pacepay/shared';
import { currentForecast, currentScores } from '../forecast';
import { defineTool } from './registry';

export const get_forecastTool = defineTool('get_forecast', TOOLS.get_forecast.input, TOOLS.get_forecast.output, async (input, ctx) => {
  const f = currentForecast(ctx, { days: input.days ?? CHART_PNG.days });
  return {
    lowest: f.lowest,
    days: f.days.map((d) => ({
      day: d.day,
      date: d.date,
      weekday: d.weekday,
      close: d.close,
      intradayLow: d.intradayLow,
      items: d.items.map((i) => ({ label: i.label, amount: i.amount })),
    })),
    scores: currentScores(ctx),
  };
});
