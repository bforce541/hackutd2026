'use client';
/**
 * Demo mode: a self-contained state machine that ports the mockup's renderVals()
 * (design/mockup/Main.dc.html) onto DashboardState, so the dashboard works with no server
 * (pacepay.work without SERVER_URL, rehearsals). Owned by: dash-demo.
 *
 * Stages follow the mockup: home (Heads up) -> limits -> call (scripted SCRIPT lines, offer
 * checks, "Call dropped? Switch to text") -> approve -> done, plus what-if and the day-11 CD alert.
 * Placeholder: only the view actions work yet; the panel and clock actions are no-ops.
 */
import { useMemo, useState } from 'react';
import type { Actions, DashboardState, UseDashboard } from './view-model';
import { demoInitialState } from './demo-data';

export function useDemoDashboard(): UseDashboard {
  const [state, setState] = useState<DashboardState>(demoInitialState);
  const actions = useMemo<Actions>(() => {
    const ui = (patch: Partial<DashboardState['ui']>) => setState((s) => ({ ...s, ui: { ...s.ui, ...patch } }));
    const noop = () => {};
    return {
      setTab: (tab) => ui({ tab }),
      setRange: (range) => ui({ range }),
      togglePresenter: () => setState((s) => ({ ...s, ui: { ...s.ui, presenter: !s.ui.presenter } })),
      toggleStat: (key) => setState((s) => ({ ...s, ui: { ...s.ui, statOpen: s.ui.statOpen === key ? null : key } })),
      pickOption: noop,
      approveLimits: noop,
      startCall: noop,
      nextLine: noop,
      failCall: noop,
      lenderSays: noop,
      approveDeal: noop,
      decline: noop,
      openActivity: () => ui({ tab: 'activity' }),
      compareCdInWhatIf: noop,
      dismissCdAlert: () => ui({ cdDismissed: true }),
      toggleWhatIf: () => setState((s) => ({ ...s, ui: { ...s.ui, whatIfOpen: !s.ui.whatIfOpen } })),
      setWhatIf: (key, on) => setState((s) => ({ ...s, ui: { ...s.ui, whatIf: { ...s.ui.whatIf, [key]: on } } })),
      skipClock: noop,
      reset: () => setState(demoInitialState),
      injectBillPhoto: noop,
      sendMessage: noop,
      setRules: (rules) => setState((s) => ({ ...s, rules })),
      togglePause: () => setState((s) => ({ ...s, rules: { ...s.rules, paused: !s.rules.paused } })),
      runArenaLive: noop,
    };
  }, []);
  return { state, actions, mode: 'demo' };
}
