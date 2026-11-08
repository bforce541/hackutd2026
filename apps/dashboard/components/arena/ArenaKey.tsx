'use client';
/** The legend under the grid (UI.md Arena). Owned by: dash-tabs-b. */
import { MARK_STYLE } from './outcome';

const KEYS = ['deal', 'no_deal', 'handoff'] as const;
const LABELS = { deal: 'Deal within limits', no_deal: 'Honest no deal', handoff: 'Handed to Yoshua (ID check)' } as const;

export function ArenaKey() {
  return (
    <ul aria-label="Key" className="m-0 mt-4 flex list-none flex-wrap gap-x-6 gap-y-1.5 p-0 text-chart text-muted">
      {KEYS.map((k) => (
        <li key={k} className="flex items-center gap-1.5">
          <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true">
            <path d={MARK_STYLE[k].path} fill="none" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: MARK_STYLE[k].color }} />
          </svg>
          {LABELS[k]}
        </li>
      ))}
    </ul>
  );
}
