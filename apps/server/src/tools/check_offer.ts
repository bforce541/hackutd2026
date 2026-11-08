/**
 * Tool `check_offer` (SPEC §5.6). Implemented by: tools-code.
 * engine.checkOffer against the stored household and current changes; emits 'offer.checked'.
 * The result is stored on the negotiation only by decide.
 */
import { TOOLS, formatDate, formatMoney } from '@pacepay/shared';
import { defineTool } from './registry';

export const check_offerTool = defineTool('check_offer', TOOLS.check_offer.input, TOOLS.check_offer.output, async (input, ctx, scope) => {
  const h = ctx.store.household();
  const check = ctx.engine.checkOffer(h, input, { baseChanges: ctx.store.forecastChanges(), fromDay: ctx.clock.today() });
  ctx.bus.emit({
    type: 'offer.checked',
    model: scope.model ?? 'code',
    caseId: scope.caseId,
    stepId: scope.stepId,
    tool: 'check_offer',
    level: check.pass ? 'info' : 'warn',
    title: `Checked ${formatDate(input.newDay, h.day0Date)} with a ${formatMoney(input.fee)} fee: ${check.pass ? 'pass' : `fail (${check.reasons.join(', ')})`}`,
    detail: { input, check },
  });
  return check;
});
