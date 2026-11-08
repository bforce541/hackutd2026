'use client';
/**
 * The three "Run 3 live" tiles under the button: each waits with the persona on the line, then
 * shows its outcome mark and lender, and opens the full transcript like a field tile. Owned by: arena.
 */
import type { CSSProperties } from 'react';
import { MARK_STYLE, markFor, personaWord } from './outcome';
import type { LiveView } from './live-store';

export function LiveRuns({ live, onOpen }: { live: LiveView; onOpen(index: number): void }) {
  return (
    <ul id="arena-live" aria-label="Live runs" className="m-0 mt-4 scroll-mb-6 grid max-w-[40rem] list-none grid-cols-3 gap-2.5 p-0">
      {live.runs.map((run, i) => {
        const persona = run?.persona ?? live.personas[i];
        const word = persona ? personaWord(persona) : 'Lender';
        const mark = run ? markFor(run.outcome) : null;
        const style = mark ? MARK_STYLE[mark] : null;
        if (!run) {
          return (
            <li key={`pending-${i}`} className="flex">
              <div
                role="status"
                aria-label={`${word}: negotiating`}
                className="flex min-h-[5.5rem] w-full flex-col items-center justify-center gap-2 rounded-2xl border border-hairline bg-panel px-2 py-3"
              >
                <span aria-hidden="true" className="flex h-[18px] items-center gap-1">
                  {[0, 1, 2].map((d) => (
                    <span
                      key={d}
                      className="size-1.5 animate-pulse rounded-full"
                      style={{ background: 'var(--ochre)', animationDelay: `${d * 220}ms` }}
                    />
                  ))}
                </span>
                <span className="text-chart text-muted">{word}</span>
                <span className="eyebrow text-muted">Negotiating</span>
              </div>
            </li>
          );
        }
        const label = `${word}: ${style ? style.text : 'no outcome'}`;
        return (
          <li key={run.id} className="flex">
            <button
              type="button"
              data-run-id={run.id}
              aria-label={`Live run ${i + 1}, ${label}. Open transcript`}
              title={label}
              onClick={() => onOpen(i)}
              className="rise flex min-h-[5.5rem] w-full flex-col items-center justify-center gap-1.5 rounded-2xl border px-2 py-3 transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)] hover:-translate-y-0.5"
              style={{ ...(style ? style.tile : {}), '--d': '0ms', animationDuration: '500ms' } as CSSProperties}
            >
              {style ? (
                <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
                  <path d={style.path} fill="none" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: style.color }} />
                </svg>
              ) : null}
              <span className="text-chart text-muted">{word}</span>
              <span className="line-clamp-2 max-w-full text-center text-chart font-medium leading-tight">{run.lenderName ?? 'Simulated lender'}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
