'use client';
/**
 * Light / Night. The choice lives on <html data-theme> (the layout's inline script restores it
 * before first paint) and in localStorage, which can throw in private windows, so every access is
 * guarded and the page works without it.
 */
import { useCallback, useSyncExternalStore } from 'react';

export type Theme = 'light' | 'night';
const KEY = 'pacepay-theme';
const EVENT = 'pacepay-theme';

function read(): Theme {
  return document.documentElement.dataset.theme === 'night' ? 'night' : 'light';
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, read, () => 'light' as Theme);

  const setTheme = useCallback((t: Theme) => {
    const root = document.documentElement;
    // A short color-only transition, removed again so nothing else animates with it.
    root.classList.add('theme-switching');
    root.dataset.theme = t;
    window.setTimeout(() => root.classList.remove('theme-switching'), 400);
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* private window: the choice just won't persist */
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);

  const toggle = useCallback(() => setTheme(read() === 'night' ? 'light' : 'night'), [setTheme]);
  return { theme, setTheme, toggle };
}
