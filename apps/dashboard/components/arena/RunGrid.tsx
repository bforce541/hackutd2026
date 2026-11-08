'use client';
/**
 * The 10 x 5 grid of run tiles (UI.md Arena): persona word and outcome mark on each tile. Without
 * results, the tiles are blank and show the persona mix the next run will draw from.
 * Owned by: dash-tabs-b.
 */
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
    <ul aria-label="Runs" className="m-0 mt-5 grid list-none grid-cols-5 gap-2 p-0 md:grid-cols-10">
      {tiles.map((t) => {
        const style = t.mark ? MARK_STYLE[t.mark] : null;
        return (
          <li
            key={t.key}
            aria-label={`${t.word}: ${style ? style.text : 'no result yet'}`}
            className="flex min-h-[3.75em] flex-col items-center justify-center gap-1 rounded-lg border px-1 py-1.5"
            style={style ? style.tile : EMPTY_TILE}
          >
            {style ? (
              <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
                <path d={style.path} fill="none" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: style.color }} />
              </svg>
            ) : (
              <span aria-hidden="true" className="h-4" />
            )}
            <span className="text-chart whitespace-nowrap">{t.word}</span>
          </li>
        );
      })}
    </ul>
  );
}
