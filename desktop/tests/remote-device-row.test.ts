// Destin, 2026-09-11: "each sign in seems to create a new device entry in the remote access
// menu? even though all the same device". The browser now remembers which row it has on each
// computer, separately from its key, and names that row when it signs in with the password, so
// losing the key never adds a row. The row id is kept per computer: another computer is never
// told it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  send(data: string) { if (this.readyState !== FakeWebSocket.OPEN) throw new Error('not open'); this.sent.push(data); }
  close() { this.readyState = 3; }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  sentOf(type: string) { return this.sent.map((s) => JSON.parse(s)).filter((m) => m.type === type); }
}

const g = globalThis as any;
let store: Record<string, string>;
const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

async function freshPage(host = 'desk:9900') {
  vi.resetModules();
  g.location = { protocol: 'http:', host, search: '' };
  const shim = await import('../src/renderer/remote-shim');
  shim.installShim();
  return shim;
}

async function passwordSignIn(shim: typeof import('../src/renderer/remote-shim'), deviceId: string) {
  const p = shim.connect('correct-horse', false);
  const ws = latest();
  ws.open();
  const auth = ws.sentOf('auth')[0];
  ws.receive({ type: 'auth:ok', deviceId, secret: `secret-${deviceId}`, platform: 'desktop' });
  await p;
  return auth;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  FakeWebSocket.instances = [];
  g.WebSocket = FakeWebSocket;
  g.window = globalThis;
  store = {};
  g.localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
});
afterEach(() => { vi.useRealTimers(); delete g.WebSocket; });

describe('one row per browser on each computer', () => {
  it('the first sign-in names no row', async () => {
    const shim = await freshPage();
    const auth = await passwordSignIn(shim, 'dev-1');
    expect(auth.previousDeviceId).toBeUndefined();
  });

  it('after the key is lost, the password sign-in names the row this browser already has', async () => {
    await passwordSignIn(await freshPage(), 'dev-1');
    delete store['youcoded-remote-token'];            // the key is gone (refused, cleared, …)
    const auth = await passwordSignIn(await freshPage(), 'dev-1');
    expect(auth.previousDeviceId).toBe('dev-1');
  });

  it('another computer is never told this one\'s row', async () => {
    await passwordSignIn(await freshPage('desk:9900'), 'dev-1');
    const auth = await passwordSignIn(await freshPage('laptop:9900'), 'dev-9');
    expect(auth.previousDeviceId).toBeUndefined();
  });
});
