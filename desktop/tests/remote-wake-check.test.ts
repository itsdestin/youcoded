// Destin, 2026-09-11, phone pass: the new-session project list was empty, then "randomly popped
// back in". A phone that sleeps can wake holding a connection that is already dead, or sit out a
// reconnect backoff of up to 30 s, while every screen it opens asks the computer for data that
// never comes. So the phone now checks the moment it wakes: reconnect at once if it is down, and
// if it thinks it is up, ask one quick question and replace the connection if nothing answers.
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

describe('checking the connection when the phone wakes', () => {
  let shim: typeof import('../src/renderer/remote-shim');
  let store: Record<string, string>;
  let doc: EventTarget & { visibilityState: string };
  const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

  async function setup(protocol = 'http:') {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    (globalThis as any).window = globalThis;
    (globalThis as any).location = { protocol, host: 'desk:9900', search: '' };
    doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
    (globalThis as any).document = doc;
    store = { 'youcoded-remote-token': 'dev-1:secret' };
    (globalThis as any).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    };
    shim = await import('../src/renderer/remote-shim');
    shim.installShim();
  }

  async function signedIn() {
    const p = shim.connect('dev-1:secret', true);
    latest().open();
    latest().receive({ type: 'auth:ok', deviceId: 'dev-1', platform: 'desktop' });
    await p;
    return latest();
  }

  const wake = () => { doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); };

  beforeEach(async () => { await setup(); });
  afterEach(() => { vi.useRealTimers(); delete (globalThis as any).WebSocket; delete (globalThis as any).document; });

  it('a live connection answers the check and is kept', async () => {
    const ws = await signedIn();
    wake();
    const ping = ws.sentOf('remote:ping')[0];
    expect(ping).toBeTruthy();
    ws.receive({ type: 'remote:ping:response', id: ping.id, payload: { ok: true } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('a connection that does not answer is replaced at once, with the saved key', async () => {
    const ws = await signedIn();
    wake();
    expect(ws.sentOf('remote:ping')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    latest().open();
    expect(latest().sentOf('auth')[0]).toMatchObject({ deviceId: 'dev-1', secret: 'secret' });
    // The old socket's late frames can no longer reach the page or close the new one.
    ws.receive({ type: 'remote:ping:response', id: ws.sentOf('remote:ping')[0].id, payload: { ok: true } });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('an older computer that does not know the check still proves the connection is alive', async () => {
    const ws = await signedIn();
    wake();
    const ping = ws.sentOf('remote:ping')[0];
    ws.receive({ type: 'remote:ping:response', id: ping.id, payload: { ok: false, unsupported: true } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('waking during a reconnect backoff reconnects now instead of waiting it out', async () => {
    const ws = await signedIn();
    ws.close(1006);                                    // dropped; first retry scheduled 1 s out
    await vi.advanceTimersByTimeAsync(1000);
    latest().close(1006);                              // that retry failed too; the next waits 2 s
    await Promise.resolve();
    const before = FakeWebSocket.instances.length;
    wake();
    expect(FakeWebSocket.instances.length).toBe(before + 1);
  });

  it('coming back online counts as waking', async () => {
    const ws = await signedIn();
    shim.checkConnectionAfterWake();
    expect(ws.sentOf('remote:ping')).toHaveLength(1);
  });

  it('one check at a time: repeated wake events send one question', async () => {
    const ws = await signedIn();
    wake(); wake(); wake();
    expect(ws.sentOf('remote:ping')).toHaveLength(1);
  });

  it('does nothing before the first sign-in: that screen owns the first connection', async () => {
    wake();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('does nothing on the Android app\'s own bridge', async () => {
    await setup('file:');
    const p = shim.connect('android-local', false);
    latest().open();
    latest().receive({ type: 'auth:ok', platform: 'android' });
    await p;
    wake();
    expect(latest().sentOf('remote:ping')).toHaveLength(0);
  });
});
