'use client';
/**
 * Messages tab (UI.md): the iMessage thread mirrored in a centered 640px column, PacePay's
 * messages in white boxes on the left, Yoshua's in a green tint on the right, chart images
 * inline, "Same thread as iMessage", and a "Message PacePay" input (actions.sendMessage).
 * Owned by: dash-tabs-a. Placeholder: plain list.
 */
import type { DashboardProps } from '@/lib/view-model';

export function MessagesTab({ state }: DashboardProps) {
  return (
    <section aria-label="Messages" className="mx-auto flex max-w-[640px] flex-col gap-3">
      <p className="text-label text-muted">Same thread as iMessage</p>
      {state.thread.map((m) => (
        <p key={m.id} className={m.direction === 'out' ? 'self-start whitespace-pre-line rounded-lg bg-panel p-3' : 'self-end rounded-lg bg-green-tint p-3'}>
          {m.text ?? 'Image'}
        </p>
      ))}
    </section>
  );
}
