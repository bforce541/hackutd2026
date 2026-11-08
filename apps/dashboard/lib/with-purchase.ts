'use client';
/**
 * Adds "Try a purchase" on top of whichever data source is active (demo or live). The typed amount
 * lives here, in the page, so neither data source needs to know about it. While an amount is typed
 * and the What-if panel is open, the pace line draws the after-purchase line against the current
 * plan; everything else passes through untouched.
 */
import { useMemo, useState } from 'react';
import { statusLineText } from '@pacepay/shared';
import { parseAmount, tryPurchase, type PayWith, type PurchaseResult } from './purchase';
import type { Actions, ChartView, DashboardState, PurchaseView, UseDashboard } from './view-model';

function hintFor(text: string): string {
  const t = text.trim();
  if (!t) return '';
  if (/^-/.test(t)) return 'Enter the amount as a positive number.';
  if (parseAmount(t) === null) return /^[\d$,.\s]+$/.test(t) ? 'Try an amount between $1 and $50,000.' : 'Use numbers only, like 900.';
  return '';
}

function purchaseChart(state: DashboardState, r: PurchaseResult): ChartView {
  const text = statusLineText({ lowest: r.lowestAfter });
  return {
    line: r.forecastAfter,
    ghost: { forecast: r.forecastNow, label: 'Current plan' },
    floor: state.rules.checkingFloor,
    status: `If you spend it: ${text.charAt(0).toLowerCase()}${text.slice(1)}`,
    lowest: r.lowestAfter,
    mode: 'what_if',
  };
}

export function useWithPurchase(live: UseDashboard): UseDashboard {
  const [text, setText] = useState('');
  const [payWith, setPayWith] = useState<PayWith>('checking');
  const { state, actions } = live;

  const amount = parseAmount(text);
  const open = state.panel.step === 'what_if';
  const { rules, acceptedChanges, day } = state;
  const range = state.ui.range;

  const result = useMemo<PurchaseResult | null>(() => {
    if (!open || amount === null) return null;
    try {
      return tryPurchase({ rules, accepted: acceptedChanges, day, amount, payWith, range });
    } catch {
      return null;
    }
  }, [open, amount, rules, acceptedChanges, day, payWith, range]);

  return useMemo<UseDashboard>(() => {
    const purchase: PurchaseView = { text, payWith, hint: hintFor(text), result };
    const merged: DashboardState = {
      ...state,
      purchase,
      chart: result ? purchaseChart(state, result) : state.chart,
    };
    const extra: Pick<Actions, 'setPurchaseText' | 'setPurchasePayWith'> = {
      setPurchaseText: setText,
      setPurchasePayWith: setPayWith,
    };
    return { ...live, state: merged, actions: { ...actions, ...extra } };
  }, [live, state, actions, text, payWith, result]);
}
