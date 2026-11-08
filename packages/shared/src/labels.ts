/**
 * Plain display names (UI.md "Numbers and words"). One place, so the dashboard, texts and feed agree.
 */
import type { Actor, CaseState, Category, OfferReason, PlanStep, ScoreKey, StepKind } from './types';

/** The "who" column on the Activity tab and the model line under each plan step. */
export const ACTOR_LABELS: Record<Actor, string> = {
  'nemotron-ultra': 'Nemotron 3 Ultra',
  'nemotron-super': 'Nemotron 3 Super',
  'nemotron-nano': 'Nemotron 3 Nano',
  'nemotron-vision': 'Nemotron Nano 2 VL',
  'claude-opus': 'Claude Opus 5.5',
  'gpt-realtime': 'GPT realtime',
  /** PacePay's spoken call lines: written by the negotiator (code), voiced by OpenAI TTS. */
  negotiator: 'Negotiator (OpenAI TTS)',
  engine: 'Engine',
  code: 'Code',
  yoshua: 'Yoshua',
};

/** Steps that wait on Yoshua: the Activity checklist shows "Yoshua" under them (UI.md), whatever model ran the wait. */
export const YOSHUA_STEP_KINDS = ['await_choice', 'confirm_limits', 'confirm_deal'] as const satisfies readonly StepKind[];

/** Who the Activity tab names under a plan step: Yoshua for his decisions, else the step's model. */
export function stepActor(step: Pick<PlanStep, 'kind' | 'model'>): Actor {
  return (YOSHUA_STEP_KINDS as readonly StepKind[]).includes(step.kind) ? 'yoshua' : step.model;
}

/** PNC's category headings on the Accounts tab, in display order. */
export const CATEGORY_LABELS: Record<Category, string> = {
  checking: 'Checking',
  savings: 'Savings',
  cds_iras: 'CDs and IRAs',
  loans: 'Loans',
  credit_cards: 'Credit cards',
  mortgage: 'Mortgage',
};

/** Plain names: "Card use", not "utilization"; "Debt vs. income", not "DTI". */
export const SCORE_LABELS: Record<ScoreKey, string> = {
  cash_cushion: 'Cash cushion',
  emergency_fund: 'Emergency fund',
  credit_use: 'Card use',
  debt_to_income: 'Debt vs. income',
};

/** The goal shown next to each health stat. */
export const SCORE_GOALS: Record<ScoreKey, string> = {
  cash_cushion: 'Goal: stay above your minimum',
  emergency_fund: 'Goal: 3–6 months',
  credit_use: 'Goal: under 30%',
  debt_to_income: 'Goal: under 36%',
};

/** Shown instead of the goal once the score is green. */
export const SCORE_ON_TRACK: Record<ScoreKey, string> = {
  cash_cushion: 'On track: above your minimum',
  emergency_fund: 'On track: 3+ months',
  credit_use: 'On track: under 30%',
  debt_to_income: 'On track: under 36%',
};

/** The one-word verdict on an offer row in the Call step (UI.md). */
export const OFFER_VERDICTS = {
  works: 'Works',
  overdrawn: 'Overdrawn',
  belowFloor: 'Below minimum',
  overLimit: 'Over limit',
  payday: 'Payday',
} as const;
export type OfferVerdict = (typeof OFFER_VERDICTS)[keyof typeof OFFER_VERDICTS];

/** Picks the single verdict word for an offer check's reasons. */
export function offerVerdict(check: { pass: boolean; reasons: OfferReason[] }): OfferVerdict {
  if (check.pass) return OFFER_VERDICTS.works;
  if (check.reasons.includes('NEGATIVE_BALANCE')) return OFFER_VERDICTS.overdrawn;
  if (check.reasons.includes('PAYDAY_SAME_DAY')) return OFFER_VERDICTS.payday;
  if (check.reasons.includes('BELOW_FLOOR')) return OFFER_VERDICTS.belowFloor;
  return OFFER_VERDICTS.overLimit;
}

/** Short state names for debugging views and the activity detail. Not shown on Home. */
export const CASE_STATE_LABELS: Record<CaseState, string> = {
  NEW: 'New',
  ANALYZING: 'Checking',
  OPTIONS_SENT: 'Options sent',
  AWAITING_CHOICE: 'Waiting for a pick',
  ADVISED: 'Advised',
  PREPARING_CALL: 'Planning the call',
  AWAITING_LIMITS: 'Waiting for an OK on the limits',
  REVIEWING: 'Second opinion',
  CALLING: 'Calling',
  NEGOTIATING: 'Negotiating',
  AWAITING_APPROVAL: 'Waiting for an OK on the deal',
  CONFIRMING: 'Confirming',
  HOLD_REQUESTED: 'Offer on hold',
  TEXT_NEGOTIATION: 'Negotiating by text',
  SUMMARIZING: 'Summarizing',
  DONE: 'Done',
};
