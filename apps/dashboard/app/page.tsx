'use client';
/**
 * The dashboard: one page, five tabs. Composes the components by tab; Home fits one laptop
 * screen (1440 x 800) and the panel wraps below the chart at phone width. Presenter mode
 * scales everything 25% through the root font size (globals.css). Owned by: dash-shell.
 */
import { useEffect } from 'react';
import { useDashboard } from '@/lib/data-source';
import { useWithPurchase } from '@/lib/with-purchase';
import { TABS } from '@/lib/view-model';
import { Header } from '@/components/Header';
import { PaceLine } from '@/components/PaceLine';
import { HealthStats } from '@/components/HealthStats';
import { PacePayPanel } from '@/components/PacePayPanel';
import { MessagesTab } from '@/components/MessagesTab';
import { ActivityTab } from '@/components/ActivityTab';
import { AccountsTab } from '@/components/AccountsTab';
import { ArenaTab } from '@/components/ArenaTab';

export default function Page() {
  const { state, actions } = useWithPurchase(useDashboard());
  const props = { state, actions };

  useEffect(() => {
    document.documentElement.dataset.presenter = String(state.ui.presenter);
  }, [state.ui.presenter]);

  useEffect(() => {
    document.documentElement.dataset.readonly = String(state.readOnly === true);
  }, [state.readOnly]);

  return (
    <div className="min-h-screen bg-page text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-label focus:font-medium focus:text-page"
      >
        Skip to content
      </a>
      <Header {...props} />
      <main id="main" className="mx-auto max-w-[1560px] px-4 pb-10 pt-1 sm:px-8 [html[data-presenter=true]_&]:pb-3">
        <h1 className="sr-only">PacePay: {TABS.find((t) => t.id === state.ui.tab)?.label}</h1>
        {state.ui.tab === 'home' && (
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(21rem,25rem)]">
            <div className="flex min-w-0 flex-col gap-3">
              <PaceLine {...props} />
              <HealthStats {...props} />
            </div>
            <PacePayPanel {...props} />
          </div>
        )}
        {state.ui.tab === 'messages' && <MessagesTab {...props} />}
        {state.ui.tab === 'activity' && <ActivityTab {...props} />}
        {state.ui.tab === 'accounts' && <AccountsTab {...props} />}
        {state.ui.tab === 'arena' && <ArenaTab {...props} />}
      </main>
    </div>
  );
}
