'use client';
/**
 * The one hook every page uses. Owned by: dash-shell.
 *
 * mode 'live' when NEXT_PUBLIC_SERVER_URL is set and GET /api/health answers within ~1.5 s (then
 * the snapshot and SSE drive the state); otherwise mode 'demo', the self-contained mockup port
 * (lib/demo-machine.ts), so pacepay.work works without a server. While demo, a configured server
 * is probed again every few seconds, so starting the server mid-rehearsal switches to live.
 */
import { useEffect, useState } from 'react';
import { probeHealth, serverUrl } from './api';
import { useDemoDashboard } from './demo-machine';
import { useLiveDashboard } from './live';
import type { UseDashboard } from './view-model';

const REPROBE_MS = 6000;

export function useDashboard(): UseDashboard {
  const base = serverUrl();
  const demo = useDemoDashboard();
  const [liveBase, setLiveBase] = useState<string | null>(null);

  useEffect(() => {
    if (!base || liveBase) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = async () => {
      const ok = await probeHealth(base, 1500);
      if (cancelled) return;
      if (ok) setLiveBase(base);
      else timer = setTimeout(probe, REPROBE_MS);
    };
    void probe();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [base, liveBase]);

  const live = useLiveDashboard(liveBase);
  return live ?? demo;
}
