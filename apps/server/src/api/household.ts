/**
 * Routes (SPEC §4). Implemented by: server-core.
 * Mounted at /api by app.ts. Endpoints this router owns:
 *   GET  /household
 *   GET  /forecast?days=60
 *   GET  /scores
 *   POST /simulate
 *   GET  /rules
 *   PUT  /rules (publish SSE 'rules')
 * Validate bodies with the request schemas in @pacepay/shared (parseBody), return the
 * response types from @pacepay/shared/api, and errors with apiError().
 */
import { Hono } from 'hono';
import type { Account, Category } from '@pacepay/shared';
import { CHART_DAYS, PutRulesRequestSchema, SimulateRequestSchema } from '@pacepay/shared';
import type { ForecastResponse, HouseholdResponse, RulesResponse, ScoresResponse, SimulateResponse } from '@pacepay/shared';
import type { ServerContext } from '../context';
import { currentForecast, currentNetWorth, currentScores } from '../forecast';
import { HttpError, parseBody } from './http';

const CATEGORIES: Category[] = ['checking', 'savings', 'cds_iras', 'loans', 'credit_cards', 'mortgage'];

export function byCategory(accounts: Account[]): Record<Category, Account[]> {
  const out = Object.fromEntries(CATEGORIES.map((c) => [c, [] as Account[]])) as Record<Category, Account[]>;
  for (const a of accounts) out[a.category].push(a);
  return out;
}

export function householdRoutes(ctx: ServerContext): Hono {
  const r = new Hono();

  r.get('/household', (c) => {
    // Balances as they stand after the changes the forecast applies.
    const after = ctx.engine.applyChanges(ctx.store.household(), ctx.store.forecastChanges());
    const body: HouseholdResponse = {
      household: after,
      netWorth: currentNetWorth(ctx),
      byCategory: byCategory(after.accounts),
    };
    return c.json(body);
  });

  r.get('/forecast', (c) => {
    const raw = c.req.query('days');
    let days: number = CHART_DAYS;
    if (raw !== undefined) {
      days = Number(raw);
      if (!Number.isInteger(days) || days < 1 || days > 366) throw new HttpError(400, 'bad_request', 'days must be an integer from 1 to 366');
    }
    const body: ForecastResponse = currentForecast(ctx, { days });
    return c.json(body);
  });

  r.get('/scores', (c) => {
    const body: ScoresResponse = currentScores(ctx);
    return c.json(body);
  });

  r.post('/simulate', async (c) => {
    const { changes } = await parseBody(c, SimulateRequestSchema);
    // The dashboard sends its what-if on top of what is already accepted (and the open case's bill).
    const body: SimulateResponse = ctx.engine.simulate(ctx.store.household(), [...ctx.store.forecastChanges(), ...changes], {
      fromDay: ctx.clock.today(),
    });
    return c.json(body);
  });

  r.get('/rules', (c) => {
    const body: RulesResponse = ctx.store.rules();
    return c.json(body);
  });

  r.put('/rules', async (c) => {
    const rules = await parseBody(c, PutRulesRequestSchema);
    const saved = ctx.store.setRules(rules);
    ctx.bus.publish({ event: 'rules', data: saved });
    ctx.bus.emit({ type: 'step.completed', model: 'code', title: 'Yoshua updated his rules', detail: { rules: saved } });
    const body: RulesResponse = saved;
    return c.json(body);
  });

  return r;
}
