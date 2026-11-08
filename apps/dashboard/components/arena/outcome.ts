/**
 * How an arena run reads on its tile (UI.md Arena): a check on a green tint = deal within limits,
 * a dash on white = honest no deal, an arrow on an ochre tint = handed to Yoshua for an ID check.
 * Owned by: dash-tabs-b. Display mapping and counting only; no money math.
 */
import type { ArenaRun, ArenaPersona, CallOutcome } from '@pacepay/shared';

export type Mark = 'deal' | 'no_deal' | 'handoff';

export function markFor(outcome: CallOutcome | undefined): Mark | null {
  switch (outcome) {
    case 'deal':
      return 'deal';
    case 'no_deal':
      return 'no_deal';
    case 'handoff_verification':
      return 'handoff';
    default:
      return null;
  }
}

export const MARK_STYLE: Record<Mark, { path: string; color: string; tile: { background: string; borderColor: string }; text: string }> = {
  deal: {
    path: 'M5 10.5 L8.5 14 L15 6.5',
    color: 'var(--green)',
    tile: {
      background: 'color-mix(in srgb, var(--leaf) 15%, var(--panel))',
      borderColor: 'color-mix(in srgb, var(--leaf) 38%, var(--hairline))',
    },
    text: 'deal within limits',
  },
  no_deal: {
    path: 'M5.5 10 H14.5',
    color: 'var(--zero-line)',
    tile: { background: 'var(--panel)', borderColor: 'var(--hairline)' },
    text: 'honest no deal',
  },
  handoff: {
    path: 'M6 14 L14 6 M8.5 6 H14 V11.5',
    color: 'var(--ochre)',
    tile: {
      background: 'color-mix(in srgb, var(--amber) 16%, var(--panel))',
      borderColor: 'color-mix(in srgb, var(--amber) 42%, var(--hairline))',
    },
    text: 'handed to Yoshua for an ID check',
  },
};

export const EMPTY_TILE = { background: 'var(--panel)', borderColor: 'var(--hairline)' };

export function countOutcomes(runs: ArenaRun[]): Record<Mark, number> {
  const counts: Record<Mark, number> = { deal: 0, no_deal: 0, handoff: 0 };
  for (const r of runs) {
    const m = markFor(r.outcome);
    if (m) counts[m] += 1;
  }
  return counts;
}

/** The persona word on a tile: "Friendly", "Fees", ... (falls back to the raw persona name). */
export const PERSONA_WORD: Record<ArenaPersona, string> = {
  cooperative: 'Friendly',
  fee_pusher: 'Fees',
  stubborn_dates: 'Firm',
  vague: 'Vague',
  flat_refusal: 'No',
  identity_check: 'ID check',
  chatty: 'Chatty',
};

export function personaWord(persona: string): string {
  return (PERSONA_WORD as Record<string, string>)[persona] ?? persona;
}
