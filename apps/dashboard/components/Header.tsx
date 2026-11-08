'use client';
/**
 * The slim header (UI.md "Navigation"): logo and five text tabs underlined when selected on the
 * left; today's date with Skip, Presenter, Reset and the avatar on the right. Owned by: dash-shell.
 */
import { CD_ALERT_DAY, formatDate } from '@pacepay/shared';
import { cn } from '@/lib/cn';
import { TABS, type DashboardProps } from '@/lib/view-model';

export function Header({ state, actions }: DashboardProps) {
  const skipLabel = state.day >= CD_ALERT_DAY ? `Back to ${formatDate(0)}` : `Skip to ${formatDate(CD_ALERT_DAY)}`;
  return (
    <header className="flex items-center justify-between gap-6 border-b border-hairline px-8 py-3">
      <div className="flex items-center gap-8">
        <span className="text-lg font-semibold text-green">PacePay</span>
        <nav aria-label="Sections" className="flex gap-5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={state.ui.tab === t.id ? 'page' : undefined}
              onClick={() => actions.setTab(t.id)}
              className={cn(
                'min-h-11 text-label font-medium underline-offset-[0.45em]',
                state.ui.tab === t.id ? 'font-semibold text-ink underline decoration-green decoration-2' : 'text-muted',
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>
      <div className="flex items-center gap-5 text-label">
        <span className="text-muted">{formatDate(state.day)}</span>
        <button type="button" className="font-medium text-green" onClick={actions.skipClock}>
          {skipLabel}
        </button>
        <button type="button" className="text-muted" onClick={actions.togglePresenter} aria-pressed={state.ui.presenter}>
          Presenter
        </button>
        <button type="button" className="text-muted" onClick={actions.reset}>
          Reset
        </button>
        <span aria-label="Yoshua" className="flex size-8 items-center justify-center rounded-full bg-green-tint font-semibold text-green">
          Y
        </span>
      </div>
    </header>
  );
}
