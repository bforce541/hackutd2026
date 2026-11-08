'use client';
/**
 * The 10 x 5 field of run tiles: one per simulated lender, leaf for a deal within limits, amber
 * for a handoff, plain for an honest no deal, with the persona word under the mark. The tiles
 * wash in one after another. Without results they show the persona mix the next run draws from.
 * Owned by: dash-tabs-b.
 */
import type { CSSProperties } from 'react';
import { ARENA_PERSONAS, ARENA_PERSONA_MIX } from '@pacepay/shared';
import type { ArenaRun } from '@pacepay/shared';
import { EMPTY_TILE, MARK_STYLE, markFor, personaWord } from './outcome';

interface Tile {
  key: string;
  word: string;
  mark: ReturnType<typeof markFor>;
}

export function RunGrid({ runs }: { runs: ArenaRun[] | null }) {
  const tiles: Tile[] = runs
    ? runs.map((r, i) => ({ key: r.id ?? String(i), word: personaWord(r.persona), mark: markFor(r.outcome) }))
    : ARENA_PERSONAS.flatMap((p) =>
        Array.from({ length: ARENA_PERSONA_MIX[p] }, (_, i) => ({
          key: `${p}-${i}`,
          word: personaWord(p),
          mark: null,
        })),
      );

  return (
    <ul aria-label="Runs" className="m-0 mt-5 grid list-none grid-cols-5 gap-2.5 p-0 md:grid-cols-10">
      {tiles.map((t, i) => {
        const style = t.mark ? MARK_STYLE[t.mark] : null;
        return (
          <li
            key={t.key}
            aria-label={`${t.word}: ${style ? style.text : 'no result yet'}`}
            title={`${t.word}: ${style ? style.text : 'no result yet'}`}
            className="rise flex min-h-[4.5rem] flex-col items-center justify-center gap-1.5 rounded-2xl border px-1 py-2 transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)] hover:-translate-y-0.5"
            style={{ ...(style ? style.tile : EMPTY_TILE), '--d': `${Math.min(i, 49) * 16}ms`, animationDuration: '600ms' } as CSSProperties}
          >
            {style ? (
              <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
                <path d={style.path} fill="none" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: style.color }} />
              </svg>
            ) : (
              <span aria-hidden="true" className="h-[18px]" />
            )}
            <span className="text-chart whitespace-nowrap text-muted">{t.word}</span>
          </li>
        );
      })}
    </ul>
  );
}
