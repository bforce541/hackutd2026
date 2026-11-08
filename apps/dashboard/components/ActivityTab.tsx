'use client';
/**
 * Activity tab (UI.md): two columns. Plan: "The $650 repair · plan written by <model>" and the
 * step checklist (done / in progress / waiting, with who runs each). Log: newest first,
 * "time · who · what" (formatClockTime, ACTOR_LABELS). Owned by: dash-tabs-a. Placeholder: the log.
 */
import { ACTOR_LABELS, formatClockTime } from '@pacepay/shared';
import type { DashboardProps } from '@/lib/view-model';

export function ActivityTab({ state }: DashboardProps) {
  const rows = [...state.activity].sort((a, b) => b.seq - a.seq);
  return (
    <section aria-label="Activity" className="flex flex-col gap-2">
      {rows.map((e) => (
        <p key={e.id} className="text-label">
          <span className="num text-muted">{formatClockTime(e.at)}</span> · {e.model ? ACTOR_LABELS[e.model] : 'Code'} · {e.title}
        </p>
      ))}
    </section>
  );
}
