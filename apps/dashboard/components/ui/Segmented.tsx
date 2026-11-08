'use client';
/**
 * A segmented control with a sliding pill under the selected option (the header tabs, the 14 / 30 /
 * 60 range). The pill is measured from the real buttons, so it fits any label width, and it slides
 * with the shared expo-out curve.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: ReactNode;
  /** Plain-text name for screen readers when the label is not plain text. */
  name?: string;
}

interface Props<T extends string | number> {
  options: SegmentedOption<T>[];
  value: T;
  onChange(value: T): void;
  /** 'tabs' marks the selected button aria-current="page"; 'toggle' uses aria-pressed. */
  kind: 'tabs' | 'toggle';
  label: string;
  size?: 'md' | 'sm';
  className?: string;
}

export function Segmented<T extends string | number>({ options, value, onChange, kind, label, size = 'md', className }: Props<T>) {
  const track = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);

  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const measure = () => {
      const on = el.querySelector<HTMLElement>('[data-on="true"]');
      if (on) setPill({ x: on.offsetLeft, w: on.offsetWidth });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, [value, options.length]);

  return (
    <div
      ref={track}
      role={kind === 'tabs' ? 'navigation' : 'group'}
      aria-label={label}
      className={cn('relative inline-flex items-center rounded-full border border-hairline bg-panel p-[3px]', className)}
    >
      {pill && (
        <span
          aria-hidden="true"
          className="absolute top-[3px] bottom-[3px] left-0 rounded-full bg-ink transition-[transform,width] duration-[600ms] ease-[var(--ease-out)]"
          style={{ transform: `translateX(${pill.x}px)`, width: pill.w }}
        />
      )}
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            data-on={on}
            aria-label={o.name}
            {...(kind === 'tabs' ? { 'aria-current': on ? 'page' : undefined } : { 'aria-pressed': on })}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative z-10 whitespace-nowrap rounded-full font-medium transition-colors duration-[var(--dur-base)]',
              size === 'md' ? 'min-h-9 px-3.5 text-label' : 'min-h-8 px-3 text-chart',
              on ? 'text-page' : 'text-muted hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
