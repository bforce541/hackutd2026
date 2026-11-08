'use client';
/**
 * The one hook every page uses. Owned by: dash-shell.
 *
 * mode 'live' when NEXT_PUBLIC_SERVER_URL is set and GET /api/health answers (then the snapshot
 * and SSE drive the state); otherwise mode 'demo', the self-contained mockup port
 * (lib/demo-machine.ts), so pacepay.work works without a server.
 * Placeholder: always demo until lib/live.ts is implemented.
 */
import { serverUrl } from './api';
import { useDemoDashboard } from './demo-machine';
import { useLiveDashboard } from './live';
import type { UseDashboard } from './view-model';

export function useDashboard(): UseDashboard {
  const demo = useDemoDashboard();
  const live = useLiveDashboard(serverUrl());
  return live ?? demo;
}
