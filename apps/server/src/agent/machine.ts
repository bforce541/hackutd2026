/**
 * SPEC §5.3: the case state machine and its hard gates. Implemented by: agent-core.
 * The transition table below is the contract; a transition not listed throws GateError, which the
 * caller logs as an 'error' activity event.
 */
import type { Approval, Case, CaseState } from '@pacepay/shared';

export const TRANSITIONS: Record<CaseState, readonly CaseState[]> = {
  NEW: ['ANALYZING'],
  ANALYZING: ['OPTIONS_SENT', 'ANALYZING', 'DONE'],
  // -> ANALYZING: a BILL_CORRECTION re-runs the case from the forecast step.
  OPTIONS_SENT: ['AWAITING_CHOICE', 'ANALYZING'],
  AWAITING_CHOICE: ['ADVISED', 'PREPARING_CALL', 'ANALYZING'],
  ADVISED: ['DONE'],
  // -> ADVISED: plan_call found no acceptable day; PacePay texts the next-best options instead.
  PREPARING_CALL: ['AWAITING_LIMITS', 'ADVISED'],
  AWAITING_LIMITS: ['REVIEWING', 'ADVISED'],
  REVIEWING: ['CALLING'],
  CALLING: ['NEGOTIATING', 'TEXT_NEGOTIATION'],
  NEGOTIATING: ['AWAITING_APPROVAL', 'SUMMARIZING', 'TEXT_NEGOTIATION'],
  TEXT_NEGOTIATION: ['AWAITING_APPROVAL', 'SUMMARIZING'],
  AWAITING_APPROVAL: ['CONFIRMING', 'NEGOTIATING', 'TEXT_NEGOTIATION', 'HOLD_REQUESTED', 'SUMMARIZING'],
  CONFIRMING: ['SUMMARIZING'],
  HOLD_REQUESTED: ['SUMMARIZING'],
  SUMMARIZING: ['DONE'],
  DONE: [],
};

export class GateError extends Error {
  readonly code = 'conflict';
}

export function canTransition(from: CaseState, to: CaseState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: CaseState, to: CaseState): void {
  if (!canTransition(from, to)) throw new GateError(`Case cannot move from ${from} to ${to}`);
}

/**
 * The place_call gates (SPEC §5.3) as one pure check, shared by tools/place_call.ts and the
 * orchestrator. Returns the reasons the call may not be placed; empty means go.
 * `approvals` are this case's approvals (case.approvalIds resolved from the store).
 */
export function placeCallBlockers(c: Case, approvals: Approval[]): string[] {
  const out: string[] = [];
  const choice = approvals.find(
    (a) => a.kind === 'option_choice' && a.status === 'answered' && a.optionIds?.[Number(a.answer) - 1] === 'move_payment',
  );
  if (c.chosenOption !== 'move_payment' || !choice) out.push("Yoshua's reply did not pick the call option");
  if (!approvals.some((a) => a.kind === 'call_limits' && a.status === 'approved')) out.push('The call limits are not approved');
  const r = c.review;
  if (!r) out.push('No second opinion yet');
  else if (r.verdict === 'revise' && !r.revisionApplied) out.push("The second opinion's fixes are not applied");
  if (c.state !== 'REVIEWING') out.push(`Case is ${c.state}, not REVIEWING`);
  return out;
}
