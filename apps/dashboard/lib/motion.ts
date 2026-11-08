'use client';
/**
 * Motion helpers. Motion here only explains a change (a number moved, a plan changed), and every
 * helper returns the final value immediately for people who ask for reduced motion.
 * No animation library: requestAnimationFrame plus an expo-out ease (the same curve as --ease-out).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

/** cubic-bezier(0.16, 1, 0.3, 1), the "fast, then settles" curve both reference sites use. */
export function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReduced(cb: () => void): () => void {
  const mq = window.matchMedia(REDUCE_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

/** True when the visitor asked for reduced motion. Server renders false. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCE_QUERY).matches,
    () => false,
  );
}

/**
 * Tweens a list of numbers toward `target` whenever it changes (a chart's day balances, say).
 * Starts from `from` on the first render (default: the target itself, so no intro), then from
 * wherever the last tween had got to, so interrupting an animation never jumps.
 */
export function useTweenArray(target: number[], opts: { ms?: number; from?: number[] } = {}): number[] {
  const { ms = 700, from } = opts;
  const reduced = useReducedMotion();
  const [value, setValue] = useState<number[]>(from ?? target);
  const live = useRef<number[]>(from ?? target);
  const key = target.join(',');

  useEffect(() => {
    const to = key === '' ? [] : key.split(',').map(Number);
    if (reduced) {
      live.current = to;
      setValue(to);
      return;
    }
    const start = live.current.length === to.length ? live.current : to;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = easeOutExpo(p);
      const next = to.map((v, i) => (start[i] ?? v) + (v - (start[i] ?? v)) * e);
      live.current = next;
      setValue(next);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [key, ms, reduced]);

  return value;
}

/** Tweens one number (the big balance). `from` makes the first render count up from there. */
export function useTween(target: number, opts: { ms?: number; from?: number } = {}): number {
  const arr = useTweenArray([target], { ms: opts.ms ?? 900, from: opts.from === undefined ? undefined : [opts.from] });
  return arr[0] ?? target;
}

/** True after the first client render, so entrance animations don't replay on every state change. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

function subscribeResize(cb: () => void): () => void {
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
}

/** The window's inner height, so the chart can fit short screens. Server renders 900. */
export function useViewportHeight(): number {
  return useSyncExternalStore(subscribeResize, () => window.innerHeight, () => 900);
}
