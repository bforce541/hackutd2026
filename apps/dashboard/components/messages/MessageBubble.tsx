/* eslint-disable @next/next/no-img-element */
import type { Message } from '@pacepay/shared';
import { serverUrl } from '@/lib/api';
import { cn } from '@/lib/cn';
import { MiniChart } from './MiniChart';

/** Live: /api/media/:id on the server. Demo: the bundled images in public/demo/. */
const DEMO_IMAGES = new Set(['/demo/brake-quote.png', '/demo/week-chart.png']);

/**
 * Width / height of each picture, so its box is the right size before it loads and the thread does
 * not jump. The two bundled demo images are exact; live media (/api/media/:id) is the quote photo
 * Yoshua sends (portrait) or the chart PacePay sends, so those use the matching default.
 */
const IMAGE_RATIO: Record<string, number> = { '/demo/brake-quote.png': 820 / 891, '/demo/week-chart.png': 1200 / 800 };
const QUOTE_PHOTO_RATIO = 3 / 4;
const CHART_RATIO = 3 / 2;

function mediaSrc(url: string): string | null {
  if (/^https?:/.test(url)) return url;
  if (DEMO_IMAGES.has(url)) return url;
  if (url.startsWith('/api/')) {
    const base = serverUrl();
    return base ? `${base}${url}` : null;
  }
  return null;
}

/** PacePay (out) on the left in a white bubble; Yoshua (in) on the right in an ink one. Each eases in. */
export function MessageBubble({ message: m }: { message: Message }) {
  const fromYoshua = m.direction === 'in';
  const src = m.imageUrl ? mediaSrc(m.imageUrl) : null;
  const isDemoChart = !!m.imageUrl && !src && !fromYoshua;
  const isPhoto = !!m.imageUrl && fromYoshua;
  const hasMedia = !!src || isDemoChart;
  const ratio = (m.imageUrl && IMAGE_RATIO[m.imageUrl]) || (fromYoshua ? QUOTE_PHOTO_RATIO : CHART_RATIO);

  return (
    <li
      className={cn(
        'rise box-border max-w-[85%] text-label leading-[1.4]',
        fromYoshua ? 'self-end rounded-[1.25rem] rounded-br-md bg-ink text-page' : 'self-start rounded-[1.25rem] rounded-bl-md border border-hairline bg-panel text-ink',
        hasMedia ? 'p-1.5' : 'px-3.5 py-2',
        hasMedia && !fromYoshua && 'w-[17.5rem]',
        hasMedia && fromYoshua && 'w-[12rem]',
      )}
      style={{ animationDuration: '520ms' }}
    >
      {src ? (
        <img
          src={src}
          alt={fromYoshua ? 'Photo of the repair quote: $650 due today' : 'Chart of checking, next 14 days: lowest −$300 on Tue, Nov 10'}
          className="block h-auto w-full rounded-[0.9rem] bg-page object-contain"
          style={{ aspectRatio: ratio }}
          loading="lazy"
        />
      ) : null}
      {isDemoChart ? <MiniChart /> : null}
      {isPhoto && !src ? <span className="block italic opacity-80">{m.text ?? 'Photo'}</span> : null}
      {m.text && !(isPhoto && !src) ? <span className={cn('block whitespace-pre-line', hasMedia && 'px-2 pb-1 pt-1.5')}>{m.text}</span> : null}
    </li>
  );
}
