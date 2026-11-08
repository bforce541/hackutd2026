/**
 * Tool `decide` (SPEC §5.6). Implemented by: negotiator.
 * The negotiator's reply to one thing the lender said; all the logic is in ../agent/negotiator.ts.
 */
import { TOOLS } from '@pacepay/shared';
import { decide } from '../agent/negotiator';
import { defineTool } from './registry';

export const decideTool = defineTool('decide', TOOLS.decide.input, TOOLS.decide.output, async (input, ctx) =>
  decide(ctx, input.negotiationId, input.utterance),
);
