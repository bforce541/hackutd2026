/**
 * The real agent (SPEC §5): event -> planner (planner.ts) -> plan validation -> steps run by
 * Super with tools -> the state machine (machine.ts) enforcing the hard gates.
 * Implemented by: agent-core.
 *
 * Contracts other streams rely on:
 * - Only the agent changes case.state, always through machine.ts assertTransition. Moving to
 *   CALLING happens when place_call returns (dispatch waits until the lender answers), then
 *   NEGOTIATING; CALL_FAILED -> TEXT_NEGOTIATION; CALL_ENDED -> SUMMARIZING -> post_call_summary.
 * - Publish SSE `case` ({ case, plan, bill }) after every state or plan-step change, and
 *   publishForecast() (../forecast.ts) after anything that changes store.forecastChanges().
 * - The bill's payment goes into case.baseChanges as soon as read_bill returns (v2.md: the
 *   forecast counts the quote as paid from checking today); buildOptions gets the household
 *   with store.acceptedChanges() applied, never the baseChanges (the bill would count twice).
 * - option_choice approvals carry optionIds in the order texted (PacePay's pick first).
 */
import type { Agent } from './index';
import type { ToolContext } from '../tools/registry';

export function createRealAgent(ctx: ToolContext): Agent {
  return {
    async handle(event) {
      ctx.bus.emit({
        type: 'event.received',
        title: `Received ${event.type} (real agent not implemented yet)`,
        model: 'code',
        level: 'warn',
        detail: event,
      });
    },
  };
}
