/**
 * Tool `read_bill` (SPEC §5.6). Implemented by: model-tools.
 * Replace notImplementedTool with defineTool('read_bill', TOOLS.read_bill.input, TOOLS.read_bill.output, async (input, ctx, scope) => ...).
 * Stores a Bill (confirmed false, source 'photo' or 'fixture') and case.billId. For the brake_quote
 * fixture the image is apps/server/fixtures/brake_quote.png like any other photo.
 */
import { notImplementedTool } from './registry';

export const read_billTool = notImplementedTool('read_bill');
