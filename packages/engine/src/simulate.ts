import { applyChanges } from './changes';
import { CHART_HORIZON_DAYS, forecast } from './forecast';
import { healthScores, householdOn, netWorth } from './scores';
import type { Change, Day, Forecast, HealthScore, Household } from './types';

/**
 * Everything the what-if panel needs for a set of changes: the 60-day checking forecast,
 * the four scores, and net worth as of `fromDay`. Pure and fast enough to run on every toggle.
 */
export function simulate(
  h: Household,
  changes: Change[],
  opts: { fromDay?: Day } = {},
): { forecast: Forecast; scores: HealthScore[]; netWorth: ReturnType<typeof netWorth> } {
  const fromDay = opts.fromDay ?? 0;
  return {
    forecast: forecast(h, { fromDay, days: CHART_HORIZON_DAYS, changes }),
    scores: healthScores(h, { fromDay, changes }),
    netWorth: netWorth(householdOn(applyChanges(h, changes), fromDay)),
  };
}
