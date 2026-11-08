/**
 * Claude reviews the call plan before dialing (SPEC §8.5). 30 s timeout: proceed with a 'warn'.
 * Implemented by: model-tools (tools/second_opinion.ts calls this).
 */
import type { CallPlan, Rules, SecondOpinion } from '@pacepay/shared';
import type { ToolContext } from '../tools/registry';

export async function reviewCallPlan(
  _ctx: ToolContext,
  _input: { callPlan: CallPlan; rules: Rules; script: string },
): Promise<SecondOpinion> {
  throw new Error('agent.reviewCallPlan: not implemented yet');
}
