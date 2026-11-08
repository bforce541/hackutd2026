import type { ActivityEvent, ModelRole } from '@pacepay/shared';
import { ACTOR_LABELS, formatClockTime } from '@pacepay/shared';
import { cn } from '@/lib/cn';

function who(e: ActivityEvent): { label: string; model?: ModelRole | 'yoshua' } {
  if (e.model) return { label: ACTOR_LABELS[e.model], model: e.model };
  if (e.type === 'message.in') return { label: ACTOR_LABELS.yoshua, model: 'yoshua' };
  return { label: ACTOR_LABELS.code, model: 'code' };
}

function detailText(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail, null, 2) ?? '';
  } catch {
    return String(detail);
  }
}

function Row({ e }: { e: ActivityEvent }) {
  const w = who(e);
  const ai = w.model?.startsWith('nemotron');
  const hasDetail = e.detail !== undefined && e.detail !== null;
  return (
    <li className="border-t border-hairline py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="num w-[4.5em] flex-none text-label text-muted">{formatClockTime(e.at)}</span>
        <span
          className={cn(
            'w-40 flex-none text-label font-semibold',
            ai ? 'text-green' : w.model === 'engine' || w.model === 'code' ? 'text-muted' : 'text-ink',
          )}
        >
          {w.label}
        </span>
        <span className={cn('min-w-0 flex-[1_1_260px]', e.level === 'error' && 'text-vermilion', e.level === 'warn' && 'text-ochre')}>
          {e.title}
        </span>
      </div>
      {hasDetail ? (
        <details className="mt-1 pl-[calc(4.5em+1rem)]">
          <summary className="cursor-pointer text-chart text-muted">Details</summary>
          <pre className="num mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words text-chart text-muted">
            {detailText(e.detail)}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

export function LogList({ events }: { events: ActivityEvent[] }) {
  const rows = [...events].sort((a, b) => b.seq - a.seq);
  return (
    <section aria-labelledby="log-h" className="min-w-0 flex-[2_1_480px]">
      <h2 id="log-h" className="m-0 text-[1.25rem] font-semibold">
        Log
      </h2>
      <p className="mb-3 mt-1 text-label text-muted">Newest first. Every model call, tool call and reply.</p>
      <ol className="m-0 list-none border-b border-hairline p-0">
        {rows.map((e) => (
          <Row key={e.id} e={e} />
        ))}
      </ol>
    </section>
  );
}
