/**
 * The server's current numbers, in one place. Implemented by: server-core.
 *
 * Every reader (api/household, api/cases snapshot, get_forecast, the watcher, chart PNGs) calls
 * these instead of calling the engine with its own idea of which changes apply. The answer is
 * always: the stored household, from the demo clock's today, with store.forecastChanges().
 */
import { CHART_DAYS, type Change, type Forecast, type HealthScore, type NetWorth } from '@pacepay/shared';
import type { ToolContext } from './tools/registry';

type Ctx = Pick<ToolContext, 'store' | 'engine' | 'clock' | 'bus'>;

/** Checking (or `accountId`) from today, `days` long (default 60), current changes plus `extra`. */
export function currentForecast(ctx: Ctx, opts: { days?: number; extra?: Change[]; accountId?: string } = {}): Forecast {
  return ctx.engine.forecast(ctx.store.household(), {
    fromDay: ctx.clock.today(),
    days: opts.days ?? CHART_DAYS,
    changes: [...ctx.store.forecastChanges(), ...(opts.extra ?? [])],
    accountId: opts.accountId,
  });
}

export function currentScores(ctx: Ctx, extra: Change[] = []): HealthScore[] {
  return ctx.engine.healthScores(ctx.store.household(), {
    fromDay: ctx.clock.today(),
    changes: [...ctx.store.forecastChanges(), ...extra],
  });
}

/** Net worth after the current changes. */
export function currentNetWorth(ctx: Ctx): NetWorth {
  const h = ctx.engine.applyChanges(ctx.store.household(), ctx.store.forecastChanges());
  return ctx.engine.netWorth(h);
}

/**
 * Call after anything that changes store.forecastChanges() (a bill read or corrected, a deal
 * accepted, a reset, a clock change): publishes SSE `forecast` and `scores` and emits one
 * `forecast.updated` activity event. Engine errors (not implemented yet) become a warn event.
 */
export function publishForecast(ctx: Ctx, scope: { caseId?: string; title?: string } = {}): void {
  try {
    const forecast = currentForecast(ctx);
    const scores = currentScores(ctx);
    ctx.bus.publish({ event: 'forecast', data: forecast });
    ctx.bus.publish({ event: 'scores', data: scores });
    ctx.bus.emit({
      type: 'forecast.updated',
      model: 'engine',
      caseId: scope.caseId,
      title: scope.title ?? 'Updated the forecast',
      detail: { lowest: forecast.lowest },
    });
  } catch (err) {
    ctx.bus.emit({ type: 'forecast.updated', model: 'engine', caseId: scope.caseId, level: 'warn', title: `Forecast not updated: ${(err as Error).message}` });
  }
}
