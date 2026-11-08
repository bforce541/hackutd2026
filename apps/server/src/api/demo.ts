/**
 * Routes (SPEC §4). Implemented by: server-core.
 * Mounted at /api by app.ts. Endpoints this router owns:
 *   POST /demo/reset (store.reset(ctx.loadHousehold()), emit demo.reset, publish SSE 'reset', then
 *        publishForecast() from ../forecast.ts)
 *   POST /demo/clock (store.setDay, emit clock.changed, publish 'clock', publishForecast(), then
 *        watcher.onClockChange)
 *   POST /demo/bill-photo (fixture 'brake_quote': the bytes of apps/server/fixtures/brake_quote.png;
 *        or multipart field 'image'. Either way routeIncoming(ctx, { image, fixture?, channel:
 *        'imessage' }), exactly like a photo Yoshua texted)
 *   POST /demo/customer-says (routeIncoming(ctx, { text, channel: 'imessage' }))
 *   POST /demo/fail-call (addition: CALL_FAILED on the active call)
 * Validate bodies with the request schemas in @pacepay/shared (parseBody), return the
 * response types from @pacepay/shared/api, and errors with apiError().
 */
import { Hono } from 'hono';
import { clearLiveArena } from '../agent/arena';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DemoClockRequestSchema, DemoBillPhotoRequestSchema, DemoCustomerSaysRequestSchema } from '@pacepay/shared';
import type { DemoBillPhotoResponse, DemoClockResponse, DemoCustomerSaysResponse, DemoFailCallResponse, DemoResetResponse } from '@pacepay/shared';
import type { ServerContext } from '../context';
import { publishForecast } from '../forecast';
import { newId } from '../ids';
import { routeIncoming } from '../messaging/router';
import { HttpError, parseBody } from './http';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures');

const ACTIVE_CALL = new Set(['dispatching', 'ringing', 'active', 'holding_for_approval']);

export function demoRoutes(ctx: ServerContext): Hono {
  const r = new Hono();

  r.post('/demo/reset', (c) => {
    ctx.store.reset(ctx.loadHousehold());
    clearLiveArena();
    ctx.bus.emit({ type: 'demo.reset', model: 'code', title: 'Reset the demo to day 0' });
    ctx.bus.publish({ event: 'reset', data: { day: ctx.store.day() } });
    publishForecast(ctx, { title: 'Reloaded the forecast after the reset' });
    const body: DemoResetResponse = { ok: true };
    return c.json(body);
  });

  r.post('/demo/clock', async (c) => {
    const req = await parseBody(c, DemoClockRequestSchema);
    const day = 'day' in req ? req.day : ctx.store.day() + req.advance;
    if (day < 0) throw new HttpError(400, 'bad_request', 'The clock cannot go before day 0');
    ctx.store.setDay(day);
    ctx.bus.emit({ type: 'clock.changed', model: 'code', title: `Demo clock moved to day ${day}`, detail: { day } });
    ctx.bus.publish({ event: 'clock', data: { day } });
    publishForecast(ctx, { title: `Recomputed the forecast from day ${day}` });
    await ctx.watcher.onClockChange(day);
    const body: DemoClockResponse = { day };
    return c.json(body);
  });

  r.post('/demo/bill-photo', async (c) => {
    const type = c.req.header('content-type') ?? '';
    if (type.includes('multipart/form-data')) {
      const form = await c.req.formData();
      const file = form.get('image');
      if (!(file instanceof File)) throw new HttpError(400, 'bad_request', 'Multipart body needs an "image" file field');
      const data = Buffer.from(await file.arrayBuffer());
      await routeIncoming(ctx, { image: { data, contentType: file.type || 'image/jpeg', name: file.name || 'bill' }, channel: 'imessage' });
    } else {
      const { fixture } = await parseBody(c, DemoBillPhotoRequestSchema);
      const data = readFileSync(join(fixtureDir, `${fixture}.png`));
      await routeIncoming(ctx, { image: { data, contentType: 'image/png', name: `${fixture}.png` }, fixture, channel: 'imessage' });
    }
    const body: DemoBillPhotoResponse = { ok: true };
    return c.json(body);
  });

  r.post('/demo/customer-says', async (c) => {
    const { text } = await parseBody(c, DemoCustomerSaysRequestSchema);
    await routeIncoming(ctx, { text, channel: 'imessage' });
    const body: DemoCustomerSaysResponse = { ok: true };
    return c.json(body);
  });

  r.post('/demo/fail-call', (c) => {
    const calls = ctx.store.list('calls');
    const open = ctx.store.currentCase()?.callId;
    const call = (open ? ctx.store.getItem('calls', open) : undefined) ?? [...calls].reverse().find((x) => ACTIVE_CALL.has(x.status));
    if (!call) throw new HttpError(409, 'conflict', 'There is no active call to fail');
    ctx.enqueue({ id: newId('evt'), at: ctx.clock.now(), type: 'CALL_FAILED', callId: call.id, negotiationId: call.negotiationId, reason: 'forced' });
    const body: DemoFailCallResponse = { ok: true };
    return c.json(body);
  });

  return r;
}
