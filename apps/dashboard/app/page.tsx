'use client';
/**
 * The dashboard: one page, five tabs. Composes the components by tab; Home fits one laptop
 * screen (1440 x 800) and drops the panel below the chart at phone width. Owned by: dash-shell.
 */
import { useEffect } from 'react';
import { formatMoney } from '@pacepay/shared';
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
    <div className="min-h-screen">
      <Header {...props} />
      <main className="px-8 py-7">
        {state.ui.tab === 'home' && (
          <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_400px]">
            <div className="flex min-w-0 flex-col gap-4">
              <div>
                <p className="num text-hero font-medium">{formatMoney(state.household.checkingBalance)}</p>
                <p className="text-muted">{state.chart.status}</p>
              </div>
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
