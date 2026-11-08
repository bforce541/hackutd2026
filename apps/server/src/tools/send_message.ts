/**
 * Tool `send_message` (SPEC §5.6). Implemented by: tools-code.
 * Replace notImplementedTool with defineTool('send_message', TOOLS.send_message.input, TOOLS.send_message.output, async (input, ctx, scope) => ...).
 * Facts check (SPEC §5.5): every $ amount and % in text must appear in a facts value, else throw
 * (the caller regenerates once, then sends a template). Sends through ../messaging/outbox.ts sendText
 * with { unprompted: scope.unprompted, caseId: scope.caseId }; a held text returns messageId ''.
 */
import { notImplementedTool } from './registry';

export const send_messageTool = notImplementedTool('send_message');
