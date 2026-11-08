/**
 * Tool `schedule_followup` (SPEC §5.6). Implemented by: tools-code.
 * Replace notImplementedTool with defineTool('schedule_followup', TOOLS.schedule_followup.input, TOOLS.schedule_followup.output, async (input, ctx, scope) => ...).
 * Stores a Followup (status 'scheduled', caseId from scope); the watcher sends due ones through
 * ../messaging/outbox.ts with unprompted: true.
 */
import { notImplementedTool } from './registry';

export const schedule_followupTool = notImplementedTool('schedule_followup');
