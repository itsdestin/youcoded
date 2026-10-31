// Pins the app side of the sign-in binding: a loopback-only one-shot listener and the poll body.
import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'http';
import { startSigninListener, type SigninListener } from '../src/main/signin-loopback';
import { createMarketplaceApiClient } from '../src/renderer/state/marketplace-api-client';

const SECRET = 'a1'.repeat(32);
const get = (port: number, path: string, method = 'GET') => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
  });
  req.on('error', reject); req.end();
});
const refused = (port: number) => get(port, '/youcoded-signin?secret=' + SECRET).then(() => false, () => true);

let open: SigninListener | null = null;
afterEach(() => { open?.close(); open = null; vi.useRealTimers(); });

describe('sign-in loopback listener', () => {
  it('binds 127.0.0.1 only, on a high port', async () => {
    open = await startSigninListener();
    expect(open.port).toBeGreaterThanOrEqual(1024);
    const addr = (open as any).port;
    expect(addr).toBeGreaterThan(0);
    // Not reachable through the machine's other addresses.
    const { networkInterfaces } = await import('os');
    const other = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (other) expect(await new Promise<boolean>((r) => { const q = http.get({ host: other.address, port: open!.port, path: '/' }, () => r(false)); q.on('error', () => r(true)); })).toBe(true);
  });

  it('rejects bad secrets, wrong paths and wrong methods, and stays open', async () => {
    open = await startSigninListener();
    for (const p of ['/youcoded-signin', '/youcoded-signin?secret=abc', '/youcoded-signin?secret=' + 'g'.repeat(64), '/youcoded-signin?secret=' + SECRET + '00', '/other?secret=' + SECRET, '/']) {
      expect((await get(open.port, p)).status, p).toBe(404);
    }
    expect((await get(open.port, '/youcoded-signin?secret=' + SECRET, 'POST')).status).toBe(404);
    expect(open.secret()).toBeNull();
  });

  it('accepts exactly one valid GET, shows a tiny local page, then closes', async () => {
    open = await startSigninListener();
    const port = open.port;
    const r = await get(port, '/youcoded-signin?secret=' + SECRET);
    expect(r.status).toBe(200);
    expect(r.body).toContain('return to YouCoded');
    expect(r.body).not.toMatch(/https?:\/\/|<script|<img|<link/i);
    expect(open.secret()).toBe(SECRET);
    // WHY waitFor: a fixed pause outruns a busy machine; wait until the listener has actually closed.
    await vi.waitFor(async () => expect(await refused(port)).toBe(true));
  });

  it('closes by itself after its time limit with no secret', async () => {
    open = await startSigninListener(150);
    const port = open.port;
    // settle: the time limit is 150 ms; probing early would itself hand the listener a secret, so wait it out.
    await new Promise((res) => setTimeout(res, 400));
    await vi.waitFor(async () => expect(await refused(port)).toBe(true), { timeout: 3000 });
    expect(open.secret()).toBeNull();
  });
});

describe('sign-in requests carry the binding', () => {
  const mk = () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ device_code: 'd', user_code: 'U', auth_url: 'x', expires_in: 9 })));
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, client: createMarketplaceApiClient({ host: 'https://h.example', getToken: () => null }) };
  };
  afterEach(() => vi.unstubAllGlobals());

  it('start sends the loopback port; poll sends the secret once known', async () => {
    const { fetchMock, client } = mk();
    await client.authStart(43210);
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body)).toEqual({ loopback_port: 43210 });
    await client.authPoll('d', SECRET);
    expect(JSON.parse((fetchMock.mock.calls[1] as any)[1].body)).toEqual({ device_code: 'd', loopback_secret: SECRET });
  });

  it('without a secret the poll body is the old one', async () => {
    const { fetchMock, client } = mk();
    await client.authPoll('d');
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body)).toEqual({ device_code: 'd' });
  });
});
