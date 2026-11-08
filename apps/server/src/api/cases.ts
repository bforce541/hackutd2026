/**
 * Routes (SPEC §4). Implemented by: server-core.
 * Mounted at /api by app.ts. Endpoints this router owns:
 *   GET  /cases/current (CurrentCaseResponse, with the case's Bill or null)
 *   GET  /calls/:id
 *   POST /approvals/:id (addition: a dashboard button. routeIncoming(ctx, { text: answer, channel:
 *        'dashboard', approvalId }) so it is handled exactly as if Yoshua texted it; 409 when the
 *        approval is not pending)
 *   GET  /snapshot (addition: SnapshotResponse; forecast/scores/netWorth from ../forecast.ts,
 *        acceptedChanges = store.forecastChanges(), lastSeq = bus.lastSeq(). If the engine throws
 *        (not implemented yet), still answer: an empty forecast and [] scores)
 * Validate bodies with the request schemas in @pacepay/shared (parseBody), return the
 * response types from @pacepay/shared/api, and errors with apiError().
 */
import { Hono } from 'hono';
import { ResolveApprovalRequestSchema } from '@pacepay/shared';
import type { Approval, CallResponse, CurrentCaseResponse, Forecast, HealthScore, ResolveApprovalResponse, SnapshotResponse } from '@pacepay/shared';
import type { ServerContext } from '../context';
import { currentForecast, currentNetWorth, currentScores } from '../forecast';
import { routeIncoming } from '../messaging/router';
import { HttpError, parseBody } from './http';
import { byCategory } from './household';

export function caseRoutes(ctx: ServerContext): Hono {
  const r = new Hono();

  function current(): CurrentCaseResponse {
    const c = ctx.store.currentCase();
    if (!c) return { case: null };
    return {
      case: c,
      plan: c.planId ? (ctx.store.getItem('plans', c.planId) ?? null) : null,
      approvals: c.approvalIds.map((id) => ctx.store.getItem('approvals', id)).filter((a): a is Approval => !!a),
      bill: c.billId ? (ctx.store.getItem('bills', c.billId) ?? null) : null,
    };
  }

  r.get('/cases/current', (c) => c.json(current()));

  r.get('/calls/:id', (c) => {
    const body: CallResponse = ctx.store.mustGet('calls', c.req.param('id'));
    return c.json(body);
  });

  r.post('/approvals/:id', async (c) => {
    const id = c.req.param('id');
    const { answer } = await parseBody(c, ResolveApprovalRequestSchema);
    const approval = ctx.store.mustGet('approvals', id);
    if (approval.status !== 'pending') throw new HttpError(409, 'conflict', `Approval ${id} is ${approval.status}, not pending`);
    await routeIncoming(ctx, { text: answer, channel: 'dashboard', approvalId: id });
    const body: ResolveApprovalResponse = { ok: true };
    return c.json(body);
  });

  r.get('/snapshot', (c) => {
    const cur = current();
    const openCase = cur.case;
    const after = ctx.engine.applyChanges(ctx.store.household(), ctx.store.forecastChanges());
    let forecast: Forecast = { accountId: '', days: [], lowest: { amount: 0, day: ctx.clock.today(), causeItemIds: [] } };
    let scores: HealthScore[] = [];
    try {
      forecast = currentForecast(ctx);
      scores = currentScores(ctx);
    } catch (err) {
      ctx.bus.emit({ type: 'forecast.updated', model: 'engine', level: 'warn', title: `Snapshot without forecast: ${(err as Error).message}` });
    }
    const body: SnapshotResponse = {
      household: after,
      netWorth: currentNetWorth(ctx),
      byCategory: byCategory(after.accounts),
      forecast,
      scores,
      acceptedChanges: ctx.store.forecastChanges(),
      rules: ctx.store.rules(),
      thread: ctx.store.thread(),
      current: cur,
      call: openCase?.callId ? (ctx.store.getItem('calls', openCase.callId) ?? null) : null,
      negotiation: openCase?.negotiationId ? (ctx.store.getItem('negotiations', openCase.negotiationId) ?? null) : null,
      day: ctx.clock.today(),
      arena: ctx.store.arena(),
      lastSeq: ctx.bus.lastSeq(),
    };
    return c.json(body);
  });

  return r;
}
