/**
 * Typed fetch client for the server (SPEC §4). Owned by: dash-shell.
 * Paths come from API in @pacepay/shared; errors arrive as ApiError bodies.
 */
import type { ApiError } from '@pacepay/shared';

export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | null,
  ) {
    super(body?.error.message ?? `Server responded ${status}`);
  }
}

export function serverUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_SERVER_URL;
  return url ? url.replace(/\/$/, '') : null;
}

async function request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, base = serverUrl()): Promise<T> {
  if (!base) throw new Error('No server URL (SERVER_URL is not set)');
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ApiError | null;
    throw new ServerError(res.status, err);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const apiGet = <T>(path: string) => request<T>('GET', path);
export const apiPost = <T>(path: string, body: unknown = {}) => request<T>('POST', path, body);
export const apiPut = <T>(path: string, body: unknown) => request<T>('PUT', path, body);
