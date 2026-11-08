import type { CSSProperties } from 'react';
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

function Row({ e, index }: { e: ActivityEvent; index: number }) {
  const w = who(e);
  const ai = w.model?.startsWith('nemotron') || w.model === 'claude-opus' || w.model === 'gpt-realtime';
  const hasDetail = e.detail !== undefined && e.detail !== null;
  return (
    <li className="rise border-t border-hairline py-3" style={{ '--d': `${Math.min(index, 12) * 28}ms`, animationDuration: '480ms' } as CSSProperties}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <span className="eyebrow num w-[5.5em] flex-none text-muted">{formatClockTime(e.at)}</span>
        <span
          className={cn(
            'eyebrow flex-none rounded-full border px-2 py-0.5',
            ai ? 'border-ink/30 text-ink' : 'border-hairline text-muted',
          )}
        >
          {w.label}
        </span>
        <span className={cn('min-w-0 flex-[1_1_16rem] leading-snug', e.level === 'error' && 'text-vermilion', e.level === 'warn' && 'text-ochre')}>
          {e.title}
        </span>
      </div>
      {hasDetail ? (
        <details className="group mt-1.5 pl-[6.1em]">
          <summary className="eyebrow inline-block cursor-pointer text-muted transition-colors hover:text-ink">Details</summary>
          <pre className="num mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-page p-3 text-chart text-muted">
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
    <section
      aria-labelledby="log-h"
      className="rise min-w-0 flex-[2_1_30rem] rounded-[1.75rem] border border-hairline bg-panel p-6 shadow-panel"
      style={{ '--d': '140ms' } as CSSProperties}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="log-h" className="eyebrow m-0 flex items-center gap-2 text-muted">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-leaf" />
          Log
        </h2>
        <span className="eyebrow text-muted">{rows.length} events</span>
      </div>
      <p className="mb-3 mt-2 text-body leading-snug">Newest first. Every model call, tool call and reply, labeled with who did it.</p>
      <ol className="m-0 max-h-[calc(100vh-18rem)] min-h-40 list-none overflow-y-auto p-0 pr-1">
        {rows.map((e, i) => (
          <Row key={e.id} e={e} index={i} />
        ))}
      </ol>
    </section>
  );
}
