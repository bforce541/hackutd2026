'use client';
/**
 * Activity tab (UI.md): two columns. Plan: "<goal> · plan written by <model>" and the step
 * checklist (done / in progress / waiting, with who runs each). Log: newest first,
 * "time · who · what" with collapsible details. Owned by: dash-tabs-a.
 */
import type { DashboardProps } from '@/lib/view-model';
import { LogList } from './activity/LogList';
import { PlanChecklist } from './activity/PlanChecklist';

export function ActivityTab({ state }: DashboardProps) {
  return (
    <div className="flex flex-wrap items-start gap-10">
      <PlanChecklist current={state.current} />
      <LogList events={state.activity} />
    </div>
  );
}
