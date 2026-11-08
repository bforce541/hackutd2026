/* eslint-disable @next/next/no-img-element */
import type { Message } from '@pacepay/shared';
import { serverUrl } from '@/lib/api';
import { cn } from '@/lib/cn';
import { MiniChart } from './MiniChart';

/** Live: /api/media/:id on the server. Demo: a bundled path, drawn as the mini chart. */
function mediaSrc(url: string): string | null {
  if (/^https?:/.test(url)) return url;
  if (url.startsWith('/api/')) {
    const base = serverUrl();
    return base ? `${base}${url}` : null;
  }
  return null;
}

/** PacePay (out) on the left in a white box; Yoshua (in) on the right in a green tint. */
export function MessageBubble({ message: m }: { message: Message }) {
  const fromYoshua = m.direction === 'in';
  const src = m.imageUrl ? mediaSrc(m.imageUrl) : null;
  const isDemoChart = !!m.imageUrl && !src && !fromYoshua;
  const isPhoto = !!m.imageUrl && fromYoshua;

  return (
    <li
      className={cn(
        'box-border rounded-xl',
        fromYoshua
          ? 'max-w-[75%] self-end bg-green-tint px-3.5 py-2'
          : 'max-w-[80%] self-start border border-hairline bg-panel px-3.5 py-2.5',
        (src || isDemoChart) && !fromYoshua && 'w-[22em]',
      )}
    >
      {src ? (
        <img
          src={src}
          alt={fromYoshua ? 'Photo sent to PacePay' : 'Chart of checking, next 14 days'}
          className="mb-1 block h-auto w-full rounded-md"
          loading="lazy"
        />
      ) : null}
      {isDemoChart ? <MiniChart /> : null}
      {isPhoto && !src ? <span className="block italic text-muted">{m.text ?? 'Photo'}</span> : null}
      {m.text && !(isPhoto && !src) ? <span className="block whitespace-pre-line">{m.text}</span> : null}
    </li>
  );
}
