'use client';
/**
 * The slim header (UI.md "Navigation"): logo and five text tabs underlined when selected on the
 * left; today's date with Skip, Presenter, Reset and the avatar on the right, plus a small
 * Demo or Live note. Owned by: dash-shell.
 */
import { CD_ALERT_DAY, formatDate } from '@pacepay/shared';
import { cn } from '@/lib/cn';
import { TABS, type DashboardProps } from '@/lib/view-model';

export function Header({ state, actions }: DashboardProps) {
  const inCall = state.panel.step === 'call' || state.panel.step === 'approve';
  const skipLabel = state.day >= CD_ALERT_DAY ? `Back to ${formatDate(0)}` : `Skip to ${formatDate(CD_ALERT_DAY)}`;
  const modeNote = state.mode === 'demo' ? 'Demo' : state.connection === 'reconnecting' ? 'Live, reconnecting' : 'Live';
  return (
    <header className="border-b border-hairline">
      <div className="flex min-h-[3.75rem] flex-wrap items-stretch gap-x-6 px-4 sm:gap-x-10 sm:px-8">
        <div className="flex min-h-11 items-center gap-2">
          <svg width="24" height="24" viewBox="0 0 28 28" aria-hidden="true">
            <path d="M3 9 H9 V19 H15 V7 H25" fill="none" stroke="var(--green)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-[1.0625rem] font-semibold tracking-[-0.01em]">PacePay</span>
        </div>
        <nav aria-label="Main" className="order-last flex w-full items-stretch gap-3.5 overflow-x-auto [scrollbar-width:none] sm:order-none sm:w-auto sm:gap-7">
          {TABS.map((t) => {
            const on = state.ui.tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                aria-current={on ? 'page' : undefined}
                onClick={() => actions.setTab(t.id)}
                className={cn(
                  'min-h-11 border-y-2 border-t-transparent px-0.5 text-[0.9375rem]',
                  on ? 'border-b-green font-semibold text-ink' : 'border-b-transparent font-medium text-muted',
                )}
              >
                {t.label}
              </button>
            );
          })}
        </nav>
        <div className="order-last flex w-full flex-wrap items-center justify-end gap-x-1 py-1 sm:order-none sm:ml-auto sm:w-auto sm:flex-nowrap [&>*]:whitespace-nowrap">
          <span title={state.notice ?? undefined} className="px-2 text-chart text-muted">
            {state.notice && state.mode === 'demo' ? state.notice : modeNote}
          </span>
          <span className="px-1 text-label font-semibold">{formatDate(state.day)}</span>
          {!inCall && (
            <button type="button" onClick={actions.skipClock} className="min-h-11 rounded-lg px-2 text-label font-semibold text-green">
              {skipLabel}
            </button>
          )}
          <span aria-hidden="true" className="mx-2 h-6 w-px bg-hairline" />
          <button
            type="button"
            aria-pressed={state.ui.presenter}
            onClick={actions.togglePresenter}
            className={cn(
              'min-h-11 rounded-lg px-3 text-label',
              state.ui.presenter ? 'bg-green-tint font-semibold text-green' : 'font-medium text-muted',
            )}
          >
            Presenter
          </button>
          <button type="button" onClick={actions.reset} className="min-h-11 rounded-lg px-3 text-label font-medium text-muted">
            Reset
          </button>
          <span
            role="img"
            aria-label="Yoshua"
            className="ml-2 flex size-8 items-center justify-center rounded-full bg-[#e2e0d9] text-[0.9375rem] font-semibold"
          >
            Y
          </span>
        </div>
      </div>
    </header>
  );
}
