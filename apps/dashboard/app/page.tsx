'use client';
/**
 * The dashboard: one page, five tabs. Composes the components by tab; Home fits one laptop
 * screen (1440 x 800) and the panel wraps below the chart at phone width. Presenter mode
 * scales everything 25% through the root font size (globals.css). Owned by: dash-shell.
 */
import { useEffect } from 'react';
import { useDashboard } from '@/lib/data-source';
import { Header } from '@/components/Header';
import { PaceLine } from '@/components/PaceLine';
import { HealthStats } from '@/components/HealthStats';
import { PacePayPanel } from '@/components/PacePayPanel';
import { MessagesTab } from '@/components/MessagesTab';
import { ActivityTab } from '@/components/ActivityTab';
import { AccountsTab } from '@/components/AccountsTab';
import { ArenaTab } from '@/components/ArenaTab';

export default function Page() {
  const { state, actions } = useDashboard();
  const props = { state, actions };

  useEffect(() => {
    document.documentElement.dataset.presenter = String(state.ui.presenter);
  }, [state.ui.presenter]);

  return (
    <div className="min-h-screen bg-page text-ink">
      <Header {...props} />
      <main className="mx-auto max-w-[1560px] px-4 pb-10 pt-1 sm:px-8 [html[data-presenter=true]_&]:pb-3">
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
