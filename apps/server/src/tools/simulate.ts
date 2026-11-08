/**
 * Tool `simulate` (SPEC §5.6). Implemented by: tools-code.
 * engine.simulate(household, [...forecastChanges, ...input.changes], { fromDay }). Changes nothing.
 */
import { TOOLS } from '@pacepay/shared';
import { defineTool } from './registry';

export const simulateTool = defineTool('simulate', TOOLS.simulate.input, TOOLS.simulate.output, async (input, ctx) => {
  const r = ctx.engine.simulate(ctx.store.household(), [...ctx.store.forecastChanges(), ...input.changes], { fromDay: ctx.clock.today() });
  return { lowest: { amount: r.forecast.lowest.amount, day: r.forecast.lowest.day }, scores: r.scores, netWorth: r.netWorth };
});
