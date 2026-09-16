// Remote access batch 2, design §1 A (T1): the shim sends `client:ready` once
// per connection generation — the first time App's chat:hydrate listener exists
// after auth:ok — with a seq that never restarts, and drops any frame from a
// socket that is no longer the current one.
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
  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('WebSocket is not OPEN');
    this.sent.push(data);
  }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  sentOf(type: string) { return this.sent.map((s) => JSON.parse(s)).filter((m) => m.type === type); }
}

describe('remote-shim client:ready', () => {
  let shim: typeof import('../src/renderer/remote-shim');
  beforeEach(async () => {
    vi.resetModules();
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    (globalThis as any).window = globalThis;
    (globalThis as any).location = { protocol: 'http:', host: 'localhost', search: '' };
    (globalThis as any).localStorage = {
      _s: {} as Record<string, string>,
      getItem(k: string) { return this._s[k] ?? null; },
      setItem(k: string, v: string) { this._s[k] = v; },
      removeItem(k: string) { delete this._s[k]; },
    };
    shim = await import('../src/renderer/remote-shim');
    shim.installShim();
  });
  afterEach(() => { vi.useRealTimers(); delete (globalThis as any).WebSocket; });

  async function authenticate(ws: FakeWebSocket, connectPromise: Promise<string>) {
    ws.open();
    ws.receive({ type: 'auth:ok', deviceId: 'dev-1', secret: 's', platform: 'desktop' });
    await connectPromise;
  }

  it('is sent the first time the chat:hydrate listener is added after auth:ok — not before', async () => {
    const p = shim.connect('pw', false);
    const ws = FakeWebSocket.instances[0];
    await authenticate(ws, p);
    expect(ws.sentOf('client:ready')).toEqual([]);          // App has not mounted its listener yet

    (window as any).claude.on.chatHydrate(() => {});
    const readies = ws.sentOf('client:ready');
    expect(readies).toHaveLength(1);
    expect(readies[0].payload).toEqual({ seq: 1, reconnect: false, ptyOffsets: {} });
    expect(readies[0].id).toBeUndefined();                    // no reply expected
  });

  it('a listener added while the socket is still authenticating sends one client:ready at auth:ok, reconnect:false', async () => {
    const p = shim.connect('pw', false);
    const ws = FakeWebSocket.instances[0];
    (window as any).claude.on.chatHydrate(() => {});           // App mounted before auth finished
    ws.open();
    expect(ws.sentOf('client:ready')).toEqual([]);
    ws.receive({ type: 'auth:ok', deviceId: 'dev-1', secret: 's', platform: 'desktop' });
    await p;
    const readies = ws.sentOf('client:ready');
    expect(readies).toHaveLength(1);
    expect(readies[0].payload).toMatchObject({ seq: 1, reconnect: false });
  });

  it('a first connect to a DIFFERENT host is not a reconnect, however many times the old one was reached', async () => {
    const p1 = shim.connect('pw', false);
    const ws1 = FakeWebSocket.instances[0];
    await authenticate(ws1, p1);
    (window as any).claude.on.chatHydrate(() => {});
    expect(ws1.sentOf('client:ready')[0].payload.reconnect).toBe(false);

    (globalThis as any).location.host = 'other-desktop:9900';   // the page now points at another host
    const p2 = shim.connect('pw', false);
    const ws2 = FakeWebSocket.instances[1];
    await authenticate(ws2, p2);
    expect(ws2.sentOf('client:ready')[0].payload).toMatchObject({ seq: 2, reconnect: false });

    const p3 = shim.connect('pw', false);                         // the same host again: now a reconnect
    const ws3 = FakeWebSocket.instances[2];
    await authenticate(ws3, p3);
    expect(ws3.sentOf('client:ready')[0].payload).toMatchObject({ seq: 3, reconnect: true });
  });

  it('a second listener add (an effect re-run, a StrictMode double mount) sends no second client:ready', async () => {
    const p = shim.connect('pw', false);
    const ws = FakeWebSocket.instances[0];
    await authenticate(ws, p);
    const h = (window as any).claude.on.chatHydrate(() => {});
    (window as any).claude.off('chat:hydrate', h);
    (window as any).claude.on.chatHydrate(() => {});
    (window as any).claude.on.chatHydrate(() => {});
    expect(ws.sentOf('client:ready')).toHaveLength(1);
  });

  it('on a reconnect the listener is still registered, so client:ready goes out on auth:ok with reconnect:true and the next seq', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = shim.connect('pw', false);
    const ws1 = FakeWebSocket.instances[0];
    await authenticate(ws1, p);
    (window as any).claude.on.chatHydrate(() => {});
    expect(ws1.sentOf('client:ready')[0].payload.seq).toBe(1);

    ws1.close();                                              // the connection drops
    vi.advanceTimersByTime(1000);                             // the shim's first reconnect delay
    const ws2 = FakeWebSocket.instances[1];
    expect(ws2).toBeDefined();
    ws2.open();
    ws2.receive({ type: 'auth:ok', deviceId: 'dev-1', platform: 'desktop' });
    await Promise.resolve();

    const readies = ws2.sentOf('client:ready');
    expect(readies).toHaveLength(1);
    expect(readies[0].payload.seq).toBe(2);                   // monotonic for the shim's lifetime
    expect(readies[0].payload.reconnect).toBe(true);
  });

  it('applies only a hydrate whose seq is the latest it sent', async () => {
    const p = shim.connect('pw', false);
    const ws = FakeWebSocket.instances[0];
    await authenticate(ws, p);
    const applied: any[] = [];
    (window as any).claude.on.chatHydrate((s: any) => applied.push(s));
    ws.receive({ type: 'chat:hydrate', payload: { sessions: [], seq: 7 } });   // stale (never sent)
    ws.receive({ type: 'chat:hydrate', payload: { sessions: [], seq: 1 } });   // the one it asked for
    ws.receive({ type: 'chat:hydrate', payload: { sessions: [] } });           // an old host sends no seq
    expect(applied.map((s) => s.seq)).toEqual([1, undefined]);
  });

  it('drops a frame from a socket that is no longer the current one', async () => {
    const p1 = shim.connect('pw', false);
    const ws1 = FakeWebSocket.instances[0];
    await authenticate(ws1, p1);
    const seen: any[] = [];
    (window as any).claude.on.sessionCreated((s: any) => seen.push(s));

    const p2 = shim.connect('pw', false);                     // a new generation replaces ws1
    const ws2 = FakeWebSocket.instances[1];
    await authenticate(ws2, p2);

    ws1.receive({ type: 'session:created', payload: { id: 'ghost' } });
    ws2.receive({ type: 'session:created', payload: { id: 'real' } });
    expect(seen.map((s) => s.id)).toEqual(['real']);
  });
});
