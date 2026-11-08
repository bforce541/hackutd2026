/**
 * Tool `simulate` (SPEC §5.6). Implemented by: tools-code.
 * Replace notImplementedTool with defineTool('simulate', TOOLS.simulate.input, TOOLS.simulate.output, async (input, ctx, scope) => ...).
 * engine.simulate(store.household(), [...store.forecastChanges(), ...input.changes], { fromDay: clock.today() }). Changes nothing.
 */
import { notImplementedTool } from './registry';

export const simulateTool = notImplementedTool('simulate');
