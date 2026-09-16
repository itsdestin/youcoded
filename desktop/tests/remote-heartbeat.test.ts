// Destin, 2026-09-11: the phone's buttons "feel unresponsive", and the dev log showed his
// phone's socket dying every 55-90 s. The computer notices a dead connection within about a
// minute; the page noticed nothing until he switched away and back, so a tap went into a socket
// that no longer existed and said nothing for the full 30 s request timeout. While the page is in
// front it now watches for silence itself, and a page that was away longer than the computer
// waits reconnects on sight instead of asking a connection that cannot answer.
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

describe('the page watches its own connection while it is in front', () => {
  let shim: typeof import('../src/renderer/remote-shim');
  let store: Record<string, string>;
  let doc: EventTarget & { visibilityState: string };
  const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

  async function setup(protocol = 'http:') {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    (globalThis as any).window = globalThis;
    (globalThis as any).location = { protocol, host: 'desk:9900', search: '' };
    doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
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

  const hide = () => { doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange')); };
  const show = () => { doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); };

  beforeEach(async () => { await setup(); });
  afterEach(() => { vi.useRealTimers(); delete (globalThis as any).WebSocket; delete (globalThis as any).document; });

  it('asks nothing while the computer is still talking', async () => {
    const ws = await signedIn();
    await vi.advanceTimersByTimeAsync(10_000);
    ws.receive({ type: 'pty:output', payload: { sessionId: 's1', data: 'x' } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.sentOf('remote:ping')).toHaveLength(0);
  });

  it('asks once the computer has gone quiet, and keeps a connection that answers', async () => {
    const ws = await signedIn();
    await vi.advanceTimersByTimeAsync(20_000);
    const ping = ws.sentOf('remote:ping')[0];
    expect(ping).toBeTruthy();
    ws.receive({ type: 'remote:ping:response', id: ping.id, payload: { ok: true } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('replaces a connection that does not answer, without waiting out a request timeout', async () => {
    const ws = await signedIn();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ws.sentOf('remote:ping')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    latest().open();
    expect(latest().sentOf('auth')[0]).toMatchObject({ deviceId: 'dev-1', secret: 'secret' });
  });

  it('leaves a hidden page alone — the browser freezes it anyway', async () => {
    const ws = await signedIn();
    hide();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(ws.sentOf('remote:ping')).toHaveLength(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('coming back after longer than the computer waits reconnects at once, asking nothing', async () => {
    const ws = await signedIn();
    hide();
    await vi.advanceTimersByTimeAsync(90_000);
    show();
    expect(ws.sentOf('remote:ping')).toHaveLength(0);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('a short absence still asks rather than dropping a good connection', async () => {
    const ws = await signedIn();
    hide();
    await vi.advanceTimersByTimeAsync(5_000);
    show();
    expect(ws.sentOf('remote:ping')).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('does not run on the Android app’s own bridge', async () => {
    await setup('file:');
    const p = shim.connect('android-local', false);
    latest().open();
    latest().receive({ type: 'auth:ok', platform: 'android' });
    await p;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(latest().sentOf('remote:ping')).toHaveLength(0);
  });

  it('stops watching once the connection is gone', async () => {
    const ws = await signedIn();
    ws.close(1006);
    await vi.advanceTimersByTimeAsync(60_000);
    // Only reconnect attempts, never a question sent into a socket that is not connected.
    for (const inst of FakeWebSocket.instances) expect(inst.sentOf('remote:ping')).toHaveLength(0);
  });
});
