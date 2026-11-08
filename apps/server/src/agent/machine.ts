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

/** The approvals of one case, newest last. */
export function caseApprovals(c: Case, lookup: (id: string) => Approval | undefined): Approval[] {
  return c.approvalIds.map(lookup).filter((a): a is Approval => !!a);
}

/**
 * The hard gates on entering a state (SPEC §5.3), beyond the transition table. Each returns the
 * reasons the move is refused; empty means go.
 */
const GUARDS: Partial<Record<CaseState, (c: Case, approvals: Approval[]) => string[]>> = {
  // The call branch starts only from Yoshua's own pick of the call option.
  PREPARING_CALL: (c, approvals) =>
    c.chosenOption === 'move_payment' &&
    approvals.some((a) => a.kind === 'option_choice' && a.status === 'answered' && a.optionIds?.[Number(a.answer) - 1] === 'move_payment')
      ? []
      : ["Yoshua's reply did not pick the call option"],
  // The second opinion (and so the call) waits for Yoshua's OK on the limits.
  REVIEWING: (_c, approvals) =>
    approvals.some((a) => a.kind === 'call_limits' && a.status === 'approved') ? [] : ['The call limits are not approved'],
  // Only a placed call moves the case to CALLING.
  CALLING: (c) => (c.callId ? [] : ['No call was placed']),
  // A deal is confirmed only after Yoshua approved it.
  CONFIRMING: (_c, approvals) =>
    approvals.some((a) => a.kind === 'deal' && a.status === 'approved') ? [] : ['Yoshua has not approved the deal'],
  // A hold is asked for only when the deal approval timed out.
  HOLD_REQUESTED: (_c, approvals) =>
    approvals.some((a) => a.kind === 'deal' && a.status === 'timeout') ? [] : ['The deal approval did not time out'],
};

/** Every reason `c` may not move to `to` (the table plus the gates). Empty = allowed. */
export function transitionBlockers(c: Case, to: CaseState, approvals: Approval[]): string[] {
  if (!canTransition(c.state, to)) return [`Case cannot move from ${c.state} to ${to}`];
  if (c.state === to) return [];
  return GUARDS[to]?.(c, approvals) ?? [];
}

/** Throws GateError when the move breaks the table or a gate. */
export function assertCaseTransition(c: Case, to: CaseState, approvals: Approval[]): void {
  const blockers = transitionBlockers(c, to, approvals);
  if (blockers.length) throw new GateError(`Case ${c.id} cannot move from ${c.state} to ${to}: ${blockers.join('; ')}`);
}

/** The place_call gates as a throw, for the orchestrator before it calls the tool. */
export function assertPlaceCallAllowed(c: Case, approvals: Approval[]): void {
  const blockers = placeCallBlockers(c, approvals);
  if (blockers.length) throw new GateError(`place_call refused: ${blockers.join('; ')}`);
}

/** States in which the case is still being worked (not DONE). */
export function isOpen(c: Case | null | undefined): c is Case {
  return !!c && c.state !== 'DONE';
}
