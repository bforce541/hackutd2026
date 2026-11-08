'use client';
/**
 * The one hook every page uses. Owned by: dash-shell.
 *
 * mode 'live' when NEXT_PUBLIC_SERVER_URL is set and GET /api/health answers within ~1.5 s (then
 * the snapshot and SSE drive the state); otherwise mode 'demo', the self-contained mockup port
 * (lib/demo-machine.ts), so pacepay.work works without a server. While demo, a configured server
 * is probed again every few seconds, so starting the server mid-rehearsal switches to live. When a
 * server is configured but does not answer (down, or the browser blocked it), the header says so
 * quietly instead of plain "Demo".
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchHealth, serverUrl } from './api';
import { useDemoDashboard } from './demo-machine';
import { useLiveDashboard } from './live';
import type { UseDashboard } from './view-model';

const REPROBE_MS = 6000;
const UNREACHABLE = "Can't reach the server, showing the demo";
const CONNECTING = 'Connecting to the server';

export function useDashboard(): UseDashboard {
  const base = serverUrl();
  const demo = useDemoDashboard();
  const [liveBase, setLiveBase] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    if (!base || liveBase) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = async () => {
      const health = await fetchHealth(base, 1500);
      if (cancelled) return;
      setUnreachable(!health);
      if (health) {
        setReadOnly(health.readOnly);
        setLiveBase(base);
      } else timer = setTimeout(probe, REPROBE_MS);
    };
    void probe();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [base, liveBase]);

  const live = useLiveDashboard(liveBase, readOnly);
  // Health answered but the snapshot has not loaded yet: still the demo, saying it is connecting.
  const note = !base || live ? null : liveBase ? CONNECTING : unreachable ? UNREACHABLE : null;
  const { state: demoState, actions: demoActions } = demo;
  const noted = useMemo(() => (note && !demoState.notice ? { ...demoState, notice: note } : demoState), [demoState, note]);
  return live ?? { state: noted, actions: demoActions, mode: 'demo' };
}
