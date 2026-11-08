import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchHealth, probeHealth } from './api';

const answer = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

afterEach(() => vi.unstubAllGlobals());

// GET /api/health is how the page decides live or demo, and whether the server is the view-only tunnel.
describe('fetchHealth', () => {
  it('a healthy server is live and not read-only', async () => {
    vi.stubGlobal('fetch', answer(200, { ok: true, day: 0 }));
    expect(await fetchHealth('http://x')).toEqual({ readOnly: false });
  });

  it('through the public tunnel the server says readOnly, and the page learns it', async () => {
    vi.stubGlobal('fetch', answer(200, { ok: true, day: 0, readOnly: true }));
    expect(await fetchHealth('http://x')).toEqual({ readOnly: true });
  });

  it('anything but a clean ok is "not there": a 500, ok:false, a network error, or a timeout', async () => {
    vi.stubGlobal('fetch', answer(500, {}));
    expect(await fetchHealth('http://x')).toBeNull();
    vi.stubGlobal('fetch', answer(200, { ok: false }));
    expect(await fetchHealth('http://x')).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await fetchHealth('http://x')).toBeNull();
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))))));
    expect(await fetchHealth('http://x', 20)).toBeNull();
  });

  it('probeHealth still answers true or false', async () => {
    vi.stubGlobal('fetch', answer(200, { ok: true, readOnly: true }));
    expect(await probeHealth('http://x')).toBe(true);
    vi.stubGlobal('fetch', answer(503, {}));
    expect(await probeHealth('http://x')).toBe(false);
  });
});
