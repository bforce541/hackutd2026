'use client';
/**
 * The header: logo, the five tabs as a sliding pill, and on the right the demo controls (the date
 * with Skip, Presenter, Reset) plus the Light / Night switch and the avatar.
 * Owned by: dash-shell.
 */
import { CD_ALERT_DAY, formatDate } from '@pacepay/shared';
import { Logo } from '@/components/Logo';
import { Segmented } from '@/components/ui/Segmented';
import { cn } from '@/lib/cn';
import { useTheme } from '@/lib/theme';
import { TABS, type DashboardProps, type Tab } from '@/lib/view-model';

const GHOST = 'min-h-9 rounded-full px-3 text-label font-medium text-muted transition-colors duration-[var(--dur-base)] hover:text-ink';

function ThemeIcon({ night }: { night: boolean }) {
  return night ? (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ) : (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z" />
    </svg>
  );
}

export function Header({ state, actions }: DashboardProps) {
  const { theme, toggle } = useTheme();
  const inCall = state.panel.step === 'call' || state.panel.step === 'approve';
  const skipped = state.day >= CD_ALERT_DAY;
  const modeNote = state.mode === 'demo' ? 'Demo' : state.connection === 'reconnecting' ? 'Reconnecting' : 'Live';

  return (
    <header className="rise" style={{ '--d': '0ms' } as React.CSSProperties}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3.5 sm:px-8">
        <Logo />

        <Segmented<Tab>
          kind="tabs"
          label="Main"
          className="order-last w-full max-w-full overflow-x-auto [scrollbar-width:none] sm:order-none sm:w-auto"
          options={TABS.map((t) => ({ value: t.id, label: t.label }))}
          value={state.ui.tab}
          onChange={actions.setTab}
        />

        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-1 gap-y-1 [&>*]:whitespace-nowrap">
          <span
            title={state.notice ?? undefined}
            className="eyebrow mr-1 flex items-center gap-1.5 px-2 text-muted [html[data-presenter=true]_&]:hidden"
          >
            <span aria-hidden="true" className={cn('size-1.5 rounded-full', state.mode === 'live' ? 'bg-leaf' : 'bg-amber')} />
            {state.notice && state.mode === 'demo' ? state.notice : modeNote}
          </span>

          <span className="eyebrow rounded-full border border-hairline px-3 py-[0.55rem] text-ink [html[data-presenter=true]_&]:hidden">
            {formatDate(state.day)}
          </span>
          {!inCall && (
            <button
              type="button"
              onClick={actions.skipClock}
              className="min-h-9 rounded-full border border-hairline bg-panel px-3.5 text-label font-medium text-ink transition-[background-color,transform] duration-[var(--dur-base)] hover:bg-secondary-hover active:scale-[0.97]"
            >
              {skipped ? `← Back to ${formatDate(0)}` : `Skip to ${formatDate(CD_ALERT_DAY)} →`}
            </button>
          )}

          <span aria-hidden="true" className="mx-1.5 h-5 w-px bg-hairline" />
          <button
            type="button"
            aria-pressed={state.ui.presenter}
            onClick={actions.togglePresenter}
            className={cn(GHOST, state.ui.presenter && 'bg-green-tint !text-green')}
          >
            Presenter
          </button>
          <button type="button" onClick={actions.reset} className={GHOST}>
            Reset
          </button>
          <button
            type="button"
            onClick={toggle}
            aria-label={theme === 'night' ? 'Switch to the light theme' : 'Switch to the night theme'}
            className="flex size-9 items-center justify-center rounded-full text-muted transition-colors duration-[var(--dur-base)] hover:text-ink"
          >
            <ThemeIcon night={theme === 'night'} />
          </button>
          <span
            role="img"
            aria-label="Yoshua"
            className="ml-1 flex size-8 items-center justify-center rounded-full bg-ink text-chart font-medium text-page"
          >
            Y
          </span>
        </div>
      </div>
    </header>
  );
}
