/**
 * Tool `schedule_followup` (SPEC §5.6). Implemented by: tools-code.
 * Stores a Followup (status 'scheduled', caseId from scope); the watcher sends due ones through
 * ../messaging/outbox.ts with unprompted: true.
 */
import { TOOLS } from '@pacepay/shared';
import { newId } from '../ids';
import { defineTool } from './registry';

export const schedule_followupTool = defineTool('schedule_followup', TOOLS.schedule_followup.input, TOOLS.schedule_followup.output, async (input, ctx, scope) => {
  const f = ctx.store.put('followups', { id: newId('fu'), caseId: scope.caseId, atDay: input.atDay, text: input.text, status: 'scheduled' });
  return { followupId: f.id };
});
