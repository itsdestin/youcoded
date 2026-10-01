// A page's one-shot socket exchange with its allowed home device
// (home-page-v2 deck, Q-where: renames and room moves happen in Home Assistant
// itself, which offers them only over its websocket).
//
// A real `ws` server stands in for the device; the injected `connect` points
// the app's socket at it, while every rule (which connection, which address,
// the home check, the key) runs on the address the page asked for.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { fingerprint, parseConnections } from '../src/main/pages/page-connections';
import { performPageSocket, MAX_SOCKET_SENDS, MAX_SOCKET_REPLIES, type PageSocketContext } from '../src/main/pages/page-socket';
import { REDACTED, type PageCredential } from '../src/main/pages/page-fetch';
import type { PageConnection, PageFetchRequest } from '../src/shared/pages-types';

const KEY = 'ha-long-lived-token-value';
const HELLO = '{"type":"auth","access_token":"{{key}}"}';
const DEVICE = '192.168.4.54:8123';

function device(over: Record<string, unknown> = {}): PageConnection {
  const [c] = parseConnections([{ id: 'ha', kind: 'device', service: 'Home Assistant', address: DEVICE, access: 'full', socketHello: HELLO, ...over }]);
  return c;
}

/** A pretend Home Assistant: greets, checks the key, answers each command. */
let server: WebSocketServer;
let port = 0;
let received: string[] = [];
let upgradeHeaders: Record<string, string | string[] | undefined> = {};
let behaviour: 'ha' | 'silent' | 'echo' | 'flood' = 'ha';

beforeEach(async () => {
  received = [];
  behaviour = 'ha';
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => server.once('listening', () => r()));
  port = (server.address() as AddressInfo).port;
  server.on('connection', (ws, req) => {
    upgradeHeaders = req.headers;
    if (behaviour === 'silent') return;
    if (behaviour === 'flood') { for (let i = 0; i < 40; i++) ws.send('x'.repeat(40_000)); return; }
    ws.send(JSON.stringify({ type: 'auth_required' }));
    let authed = false;
    ws.on('message', (raw) => {
      const text = raw.toString();
      received.push(text);
      const m = JSON.parse(text);
      if (behaviour === 'echo') { ws.send(`you said ${text}`); return; }
      if (!authed) {
        if (m.type === 'auth' && m.access_token === KEY) { authed = true; ws.send(JSON.stringify({ type: 'auth_ok' })); }
        else { ws.send(JSON.stringify({ type: 'auth_invalid', message: `bad token ${m.access_token}` })); ws.close(); }
        return;
      }
      ws.send(JSON.stringify({ id: m.id, type: 'result', success: true, result: { echoed: m } }));
    });
  });
});
afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); });

const connected: string[] = [];
function ctx(conns: PageConnection[], over: Partial<PageSocketContext> = {}): PageSocketContext {
  return {
    connections: conns,
    approved: Object.fromEntries(conns.map((c) => [c.id, fingerprint(c)])),
    credential: async (): Promise<PageCredential> => ({ in: 'header', param: 'authorization', value: `Bearer ${KEY}`, secret: KEY }),
    signal: new AbortController().signal,
    lookup: async () => { throw new Error('no DNS in this test'); },
    // The rules ran on the page's address; only the wire goes to the stand-in.
    connect: (url, headers) => {
      connected.push(url);
      return new WebSocket(`ws://127.0.0.1:${port}${new URL(url).pathname}${new URL(url).search}`, { headers, followRedirects: false });
    },
    ...over,
  };
}

const ask = (send: unknown[], until: number, url = `http://${DEVICE}/api/websocket`, timeoutMs?: number): PageFetchRequest =>
  ({ url, socket: { send: send.map((m) => JSON.stringify(m)), until, ...(timeoutMs ? { timeoutMs } : {}) } });

describe('the greeting the page approved carries the key; the page never does', () => {
  it('signs in with the saved key and returns every answer, in order', async () => {
    connected.length = 0;
    const r = await performPageSocket(ask([{ id: 1, type: 'config/entity_registry/update', entity_id: 'light.lamp', name: 'Reading lamp' }], 3), ctx([device()]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const frames = JSON.parse(r.body).map((f: string) => JSON.parse(f));
    expect(frames.map((f: { type: string }) => f.type)).toEqual(['auth_required', 'auth_ok', 'result']);
    expect(frames[2].result.echoed.name).toBe('Reading lamp');
    // The app sent the greeting with the key substituted, then the page's own.
    expect(JSON.parse(received[0])).toEqual({ type: 'auth', access_token: KEY });
    expect(connected[0]).toBe(`ws://${DEVICE}/api/websocket`);
  });

  it('a key echoed back by the device is hidden from the page', async () => {
    behaviour = 'echo';
    const r = await performPageSocket(ask([], 2), ctx([device()]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).not.toContain(KEY);
    expect(r.body).toContain(REDACTED);
  });

  it('a page writing the key token itself sends the token, never the key', async () => {
    behaviour = 'echo';
    const r = await performPageSocket(ask([{ id: 1, type: 'x', name: '{{key}}' }], 3), ctx([device()]));
    expect(r.ok).toBe(true);
    expect(received[1]).toContain('{{key}}');
    expect(received.slice(1).join('')).not.toContain(KEY);
  });

  it('a refused key ends the exchange with the device\'s own answer, key hidden', async () => {
    const r = await performPageSocket(ask([{ id: 1, type: 'x' }], 3), ctx([device()], {
      credential: async () => ({ in: 'header', param: 'authorization', value: 'Bearer wrong-key-1234', secret: 'wrong-key-1234' }),
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toContain('auth_invalid');
    expect(r.body).not.toContain('wrong-key-1234');
  });

  it('with no greeting, the key rides the upgrade request the way a fetch would', async () => {
    behaviour = 'echo';
    const r = await performPageSocket(ask([], 1), ctx([device({ socketHello: undefined })]));
    expect(r.ok).toBe(true);
    expect(upgradeHeaders.authorization).toBe(`Bearer ${KEY}`);
  });

  it('a greeting that needs a key refuses when none is saved', async () => {
    const r = await performPageSocket(ask([], 2), ctx([device()], { credential: async () => null }));
    expect(r).toMatchObject({ ok: false, reason: 'not-approved' });
  });
});

describe('only the allowed device, only at its address', () => {
  it('refuses a connection that is not a device', async () => {
    const [key] = parseConnections([{ id: 'w', kind: 'key', service: 'Weather', address: 'api.weather.test', access: 'full' }]);
    const r = await performPageSocket(ask([], 1, 'https://api.weather.test/socket'), ctx([key]));
    expect(r).toMatchObject({ ok: false, reason: 'not-approved' });
  });

  it('refuses another port on the same box', async () => {
    const r = await performPageSocket(ask([], 1, 'http://192.168.4.54:8124/api/websocket'), ctx([device()]));
    expect(r).toMatchObject({ ok: false, reason: 'not-approved' });
  });

  it('refuses a device that may only look things up', async () => {
    const r = await performPageSocket(ask([], 1), ctx([device({ access: 'lookup' })]));
    expect(r).toMatchObject({ ok: false, reason: 'method-not-allowed' });
  });

  it('refuses before approval, and after the greeting changes', async () => {
    const c = device();
    const r1 = await performPageSocket(ask([], 1), ctx([c], { approved: {} }));
    expect(r1).toMatchObject({ ok: false, reason: 'not-approved' });
    const old = fingerprint(device({ socketHello: undefined }));
    const r2 = await performPageSocket(ask([], 1), ctx([c], { approved: { ha: old } }));
    expect(r2).toMatchObject({ ok: false, reason: 'not-approved' });
  });

  it('a ws:// address is held to the same rule as http://', async () => {
    const r = await performPageSocket(ask([], 2, `ws://${DEVICE}/api/websocket`), ctx([device()]));
    expect(r.ok).toBe(true);
  });

  it('a name that points outside the home is refused before any socket opens', async () => {
    connected.length = 0;
    const [named] = parseConnections([{ id: 'ha', kind: 'device', service: 'Home Assistant', address: 'ha.local:8123', access: 'full', socketHello: HELLO }]);
    const r = await performPageSocket(ask([], 1, 'http://ha.local:8123/api/websocket'), ctx([named], {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    }));
    expect(r).toMatchObject({ ok: false, reason: 'network' });
    expect(connected).toEqual([]);
  });
});

describe('caps', () => {
  it('refuses too many messages, and an impossible number of answers', async () => {
    const many = Array.from({ length: MAX_SOCKET_SENDS + 1 }, (_, i) => ({ id: i }));
    expect(await performPageSocket(ask(many, 1), ctx([device()]))).toMatchObject({ ok: false, reason: 'bad-url' });
    expect(await performPageSocket(ask([], MAX_SOCKET_REPLIES + 1), ctx([device()]))).toMatchObject({ ok: false, reason: 'bad-url' });
    expect(await performPageSocket(ask([], 0), ctx([device()]))).toMatchObject({ ok: false, reason: 'bad-url' });
  });

  it('gives up on a device that never answers', async () => {
    behaviour = 'silent';
    const started = Date.now();
    const r = await performPageSocket(ask([], 1, undefined, 300), ctx([device()]));
    expect(r).toMatchObject({ ok: false, reason: 'network' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('stops a device that answers with more than a page may receive', async () => {
    behaviour = 'flood';
    const r = await performPageSocket(ask([], 50), ctx([device()]));
    expect(r).toMatchObject({ ok: false, reason: 'network' });
  });
});

describe('the greeting in the manifest', () => {
  it('is kept when sound, dropped when it names the key twice or is too long', () => {
    expect((device() as { socketHello?: string }).socketHello).toBe(HELLO);
    expect((device({ socketHello: '{{key}}{{key}}' }) as { socketHello?: string }).socketHello).toBeUndefined();
    expect((device({ socketHello: 'x'.repeat(600) }) as { socketHello?: string }).socketHello).toBeUndefined();
  });

  it('leaves the fingerprint of a device without one unchanged', () => {
    expect(fingerprint(device({ socketHello: undefined }))).toBe('device|Home Assistant|full|key');
    expect(fingerprint(device())).toBe(`device|Home Assistant|full|key|hello:${HELLO}`);
  });
});
