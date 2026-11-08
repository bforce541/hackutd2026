'use client';
/**
 * "Next 14 days" (UI.md): date · name · signed amount, straight from the current plan's forecast.
 * A payment the accepted changes moved gets the green tint. Owned by: dash-tabs-b.
 */
import type { CSSProperties } from 'react';
import { formatDate, formatSignedMoney } from '@pacepay/shared';
import { cn } from '@/lib/cn';
import type { DashboardState } from '@/lib/view-model';

interface Row {
  key: string;
  day: number;
  name: string;
  amount: number;
  moved: boolean;
}

export function NextDays({ state }: { state: DashboardState }) {
  const { day, forecast, acceptedChanges, household } = state;
  const moved = new Set(acceptedChanges.flatMap((c) => (c.type === 'move_item' ? [c.itemId] : [])));

  const rows: Row[] = forecast.days
    .filter((d) => d.day >= day && d.day < day + 14)
    .flatMap((d) =>
      d.items.map((it, i) => ({
        key: `${d.day}-${it.itemId}-${i}`,
        day: d.day,
        name: it.label,
        amount: it.amount,
        moved: moved.has(it.itemId),
      })),
    )
    .sort((a, b) => a.day - b.day || a.amount - b.amount);

  const dateLabel = (d: number) => {
    if (d === day) return 'Today';
    if (d === day + 1) return 'Tomorrow';
    return formatDate(d, household.day0Date);
  };

  return (
    <section aria-labelledby="up-h" className="rise rounded-[1.5rem] border border-hairline bg-panel p-5 shadow-panel" style={{ '--d': '120ms' } as CSSProperties}>
      <h2 id="up-h" className="eyebrow m-0 text-muted">
        Next 14 days
      </h2>
      {rows.length === 0 ? (
        <p className="m-0 mt-3 text-muted">Nothing scheduled.</p>
      ) : (
        <ul className="m-0 mt-3 list-none p-0">
          {rows.map((r) => (
            <li
              key={r.key}
              className={cn('-mx-2 flex items-baseline gap-3 rounded-xl px-2 py-2 transition-colors duration-[var(--dur-slow)]', r.moved && 'bg-green-tint')}
            >
              <span className="eyebrow w-[5.75rem] flex-none text-muted">{dateLabel(r.day)}</span>
              <span className="min-w-0 flex-1 leading-tight">
                {r.name}
                {r.moved ? <span className="eyebrow ml-2 text-green">Moved</span> : null}
              </span>
              <span className={cn('num flex-none text-right font-medium', r.amount > 0 && 'text-green')}>{formatSignedMoney(r.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
