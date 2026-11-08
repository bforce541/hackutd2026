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
      <main className="px-4 pb-8 pt-6 sm:px-8 sm:pt-7 [html[data-presenter=true]_&]:pb-3 [html[data-presenter=true]_&]:pt-3">
        {state.ui.tab === 'home' && (
          <div className="flex flex-wrap items-start gap-10">
            <div className="min-w-0 flex-[999_1_560px]">
              <PaceLine {...props} />
              <HealthStats {...props} />
            </div>
            <div className="min-w-0 flex-[1_1_380px]">
              <PacePayPanel {...props} />
            </div>
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
