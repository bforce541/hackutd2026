'use client';
/**
 * Live mode: DashboardState from GET /api/snapshot plus the SSE stream, and Actions that call
 * the server (approvals through POST /api/approvals/:id, the lender console, demo controls).
 * The what-if panel still runs @pacepay/engine in the browser. Owned by: dash-shell.
 * Placeholder: returns null (not connected) until implemented.
 */
import type { UseDashboard } from './view-model';

export function useLiveDashboard(_baseUrl: string | null): UseDashboard | null {
  return null;
}
