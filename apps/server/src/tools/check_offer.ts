/**
 * Tool `check_offer` (SPEC §5.6). Implemented by: tools-code.
 * Replace notImplementedTool with defineTool('check_offer', TOOLS.check_offer.input, TOOLS.check_offer.output, async (input, ctx, scope) => ...).
 * Uses engine.checkOffer(store.household(), input, { baseChanges: store.forecastChanges(), fromDay: clock.today() }).
 * Stores the OfferCheck on the negotiation (negotiation.checks) only via decide; this tool just checks and emits 'offer.checked'.
 */
import { notImplementedTool } from './registry';

export const check_offerTool = notImplementedTool('check_offer');
