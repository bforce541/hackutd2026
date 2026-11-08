/**
 * Tool `send_chart` (SPEC §5.6). Implemented by: tools-code.
 * Renders ../messaging/chart.ts from ../forecast.ts currentForecast (14 days). what_if adds
 * input.changes, with the current plan drawn as the 'Before' ghost. Sends through outbox sendImage.
 */
import { CHART_PNG, TOOLS } from '@pacepay/shared';
import { currentForecast } from '../forecast';
import { renderChartPng } from '../messaging/chart';
import { sendImage } from '../messaging/outbox';
import { defineTool } from './registry';

export const send_chartTool = defineTool('send_chart', TOOLS.send_chart.input, TOOLS.send_chart.output, async (input, ctx, scope) => {
  const base = currentForecast(ctx, { days: CHART_PNG.days });
  const extra = input.kind === 'what_if' ? (input.changes ?? []) : [];
  const forecast = extra.length ? currentForecast(ctx, { days: CHART_PNG.days, extra }) : base;
  const png = renderChartPng({
    forecast,
    rules: ctx.store.rules(),
    day0Date: ctx.store.household().day0Date,
    days: CHART_PNG.days,
    ghost: extra.length ? { forecast: base, label: 'Before' } : undefined,
  });
  const name = `${extra.length ? 'what-if' : 'week'}-day${ctx.clock.today()}.png`;
  const r = await sendImage(ctx, png, name, { unprompted: scope.unprompted, caseId: scope.caseId, stepId: scope.stepId, model: scope.model, source: 'chart' });
  return r.sent ? { messageId: r.message.id, mediaId: r.mediaId ?? '' } : { messageId: '', mediaId: '' };
});
