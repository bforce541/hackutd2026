/**
 * Tool `post_call_summary` (SPEC §5.6). Implemented by: model-tools.
 * Replace notImplementedTool with defineTool('post_call_summary', TOOLS.post_call_summary.input, TOOLS.post_call_summary.output, async (input, ctx, scope) => ...).
 * Super writes 2-3 lines from the call's (or, for text mode, the negotiation's) transcript and
 * outcome; sends through ../messaging/outbox.ts; stores summary and referenceNumber on the Call.
 */
import { notImplementedTool } from './registry';

export const post_call_summaryTool = notImplementedTool('post_call_summary');
