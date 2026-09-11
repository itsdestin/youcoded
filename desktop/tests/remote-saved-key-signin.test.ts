// Destin, 2026-09-11, phone pass of remote access batches 2/3: "password screen occasionally
// flickering before loading back into the thing without actually needing a password".
//
// Two faults behind it, both older than the branch. The page drew the password screen for
// as long as the saved key's sign-in took, and ANY failure of that sign-in — a phone that
// just woke with no network yet, a computer restarting — deleted the saved key, so the next
// page load really did need the password. Only the computer refusing the key may forget it.
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
  close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code, reason }); }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  sentOf(type: string) { return this.sent.map((s) => JSON.parse(s)).filter((m) => m.type === type); }
}

const KEY = 'youcoded-remote-token';

describe('signing in with the saved key when the page loads', () => {
  let shim: typeof import('../src/renderer/remote-shim');
  let store: Record<string, string>;
  let events: any[];
  const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    (globalThis as any).window = globalThis;
    (globalThis as any).location = { protocol: 'http:', host: 'desk:9900', search: '' };
    store = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    };
    shim = await import('../src/renderer/remote-shim');
    shim.installShim();
    events = [];
  });
  afterEach(() => { vi.useRealTimers(); delete (globalThis as any).WebSocket; });

  const start = () => shim.startSavedKeySignIn((e) => events.push(e));

  it('does nothing without a saved key', () => {
    expect(start()).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('a computer it cannot reach keeps the key, says so, and tries again', async () => {
    store[KEY] = 'dev-1:secret';
    expect(start()).toBe(true);
    latest().close(1006);                              // never opened: no network yet
    await Promise.resolve();
    expect(store[KEY]).toBe('dev-1:secret');
    expect(events).toEqual([{ type: 'failed', kind: 'unreachable' }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);   // the next attempt, with the same key
    latest().open();
    // readyHandshake: the host waits for this page's client:ready instead of its 5 s guess.
    expect(latest().sentOf('auth')[0]).toMatchObject({ deviceId: 'dev-1', secret: 'secret', readyHandshake: true });
  });

  it('a busy computer (too many attempts) is not "unreachable", and the key stays', async () => {
    store[KEY] = 'dev-1:secret';
    start();
    latest().open();
    latest().close(4029, 'Too many');
    await Promise.resolve();
    expect(events).toEqual([{ type: 'failed', kind: 'rate-limited' }]);
    expect(store[KEY]).toBe('dev-1:secret');
  });

  it.each(['revoked', 'unknown', 'invalid-credentials'])('a key the computer refuses (%s) is forgotten, and nothing retries', async (reason) => {
    store[KEY] = 'dev-1:secret';
    start();
    latest().open();
    latest().receive({ type: 'auth:failed', reason });
    await Promise.resolve();
    expect(store[KEY]).toBeUndefined();
    expect(events).toEqual([{ type: 'refused', reason }]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('a computer with no password yet refuses without costing the key', async () => {
    store[KEY] = 'dev-1:secret';
    start();
    latest().open();
    latest().receive({ type: 'auth:failed', reason: 'no-password-configured' });
    await Promise.resolve();
    expect(store[KEY]).toBe('dev-1:secret');
    expect(events).toEqual([{ type: 'refused', reason: 'no-password-configured' }]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('"Enter password instead" stops the retries; "Try now" does not wait for the backoff', async () => {
    store[KEY] = 'dev-1:secret';
    start();
    latest().close(1006);
    await Promise.resolve();
    shim.retrySavedKeyNow();
    expect(FakeWebSocket.instances).toHaveLength(2);
    latest().close(1006);
    await Promise.resolve();
    shim.stopSavedKeySignIn();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(store[KEY]).toBe('dev-1:secret');
  });

  it('a successful sign-in stops reporting', async () => {
    store[KEY] = 'dev-1:secret';
    start();
    latest().open();
    latest().receive({ type: 'auth:ok', deviceId: 'dev-1', platform: 'desktop' });
    await Promise.resolve();
    expect(events).toEqual([]);
    expect(store[KEY]).toBe('dev-1:secret');
  });

  it('a reconnect after a drop whose key is then refused stops instead of retrying forever', async () => {
    store[KEY] = 'dev-1:secret';
    start();
    latest().open();
    latest().receive({ type: 'auth:ok', deviceId: 'dev-1', platform: 'desktop' });
    await Promise.resolve();
    latest().close(1006);                              // a drop
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    latest().open();
    latest().receive({ type: 'auth:failed', reason: 'revoked' });
    latest().close(4003, 'Device unpaired');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(store[KEY]).toBeUndefined();
  });
});
