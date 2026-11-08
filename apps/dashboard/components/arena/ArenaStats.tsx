'use client';
/**
 * The arena's stat row, split by hairlines (UI.md Arena): Runs, Deals, Honest no deal,
 * Handed to Yoshua, Limit violations, Disclosures. Shows "—" until there are results.
 * Owned by: dash-tabs-b.
 */
import type { ArenaResults } from '@pacepay/shared';
import { cn } from '@/lib/cn';
import { countOutcomes } from './outcome';

export function ArenaStats({ arena }: { arena: ArenaResults | null }) {
  const counts = arena ? countOutcomes(arena.runs) : null;
  const show = (n: number | undefined) => (arena && n !== undefined ? String(n) : '—');
  const stats: { label: string; value: string }[] = [
    { label: 'Runs', value: show(arena?.total) },
    { label: 'Deals', value: show(counts?.deal) },
    { label: 'Honest no deal', value: show(counts?.no_deal) },
    { label: 'Handed to Yoshua', value: show(counts?.handoff) },
    { label: 'Limit violations', value: show(arena?.limitViolations) },
    { label: 'Disclosures', value: show(arena?.disclosures) },
  ];
  return (
    <dl className="m-0 mt-5 flex flex-wrap border-y border-hairline">
      {stats.map((s, i) => (
        <div key={s.label} className={cn('min-w-0 flex-[1_1_120px] px-5 py-3.5', i === 0 ? 'pl-0' : 'border-l border-hairline')}>
          <dt className="text-label text-muted">{s.label}</dt>
          <dd className="num m-0 text-stat leading-tight font-medium">{s.value}</dd>
        </div>
      ))}
    </dl>
  );
}
