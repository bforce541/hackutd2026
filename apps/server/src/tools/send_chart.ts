/**
 * Tool `send_chart` (SPEC §5.6). Implemented by: tools-code.
 * Replace notImplementedTool with defineTool('send_chart', TOOLS.send_chart.input, TOOLS.send_chart.output, async (input, ctx, scope) => ...).
 * Renders ../messaging/chart.ts renderChartPng from ../forecast.ts currentForecast (14 days; what_if adds
 * input.changes with the current plan as the 'Before' ghost), then ../messaging/outbox.ts sendImage.
 */
import { notImplementedTool } from './registry';

export const send_chartTool = notImplementedTool('send_chart');
