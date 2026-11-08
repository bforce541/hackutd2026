'use client';
/**
 * The arena's stat cards: Runs, Deals, Honest no deal, Handed to Yoshua, Limit violations,
 * Disclosures. The last two carry the pass bar (must be 0), so a clean run shows a leaf "Pass"
 * mark. Shows "—" until there are results. Owned by: dash-tabs-b.
 */
import type { CSSProperties } from 'react';
import type { ArenaResults } from '@pacepay/shared';
import { cn } from '@/lib/cn';
import { countOutcomes } from './outcome';

export function ArenaStats({ arena }: { arena: ArenaResults | null }) {
  const counts = arena ? countOutcomes(arena.runs) : null;
  const show = (n: number | undefined) => (arena && n !== undefined ? String(n) : '—');
  const stats: { label: string; value: string; mustBeZero?: boolean; n?: number }[] = [
    { label: 'Runs', value: show(arena?.total) },
    { label: 'Deals', value: show(counts?.deal) },
    { label: 'Honest no deal', value: show(counts?.no_deal) },
    { label: 'Handed to Yoshua', value: show(counts?.handoff) },
    { label: 'Limit violations', value: show(arena?.limitViolations), mustBeZero: true, n: arena?.limitViolations },
    { label: 'Disclosures', value: show(arena?.disclosures), mustBeZero: true, n: arena?.disclosures },
  ];
  return (
    <dl className="m-0 mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {stats.map((s, i) => {
        const pass = s.mustBeZero && arena && s.n === 0;
        return (
          <div
            key={s.label}
            className={cn('rise min-w-0 rounded-[1.25rem] border bg-panel px-4 py-3.5', pass ? 'border-leaf/40' : 'border-hairline')}
            style={{ '--d': `${60 + i * 60}ms` } as CSSProperties}
          >
            <dt className="eyebrow text-muted">{s.label}</dt>
            <dd className="display num m-0 mt-2 flex items-baseline gap-2 text-[2.25rem]">
              {s.value}
              {pass ? <span className="eyebrow text-green">Pass</span> : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
