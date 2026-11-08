/**
 * Small HTTP helpers shared by every router: the SPEC §4 error shape, body validation and the
 * localhost-only guard for /api/voice/*. Implemented by: server-core.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import type { ApiError, ApiErrorCode } from '@pacepay/shared';
import { getConnInfo } from '@hono/node-server/conninfo';

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function apiError(c: Context, status: ContentfulStatusCode, code: ApiErrorCode, message: string) {
  const body: ApiError = { error: { code, message } };
  return c.json(body, status);
}

export function notImplemented(c: Context, what: string) {
  return apiError(c, 501, 'not_implemented', `${what} is not implemented yet`);
}

/** Parse and validate a JSON body; throws HttpError(400) on failure. */
export async function parseBody<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'bad_request', 'Body must be JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(400, 'bad_request', r.error.message);
  return r.data;
}

const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** SPEC §4: /api/voice/* accepts requests from localhost only. */
export const localOnly: MiddlewareHandler = async (c, next) => {
  let addr: string | undefined;
  try {
    addr = getConnInfo(c).remote.address;
  } catch {
    addr = undefined;
  }
  if (!addr || !LOCAL.has(addr)) return apiError(c, 403, 'forbidden', 'Voice endpoints accept localhost only');
  await next();
};
