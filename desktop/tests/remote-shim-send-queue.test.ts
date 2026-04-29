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
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error('WebSocket is not OPEN');
    }
    this.sent.push(data);
  }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

describe('remote-shim send queue', () => {
  let shim: typeof import('../src/renderer/remote-shim');
  beforeEach(async () => {
    vi.resetModules();
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    (globalThis as any).window = globalThis;
    (globalThis as any).location = { protocol: 'ws:', host: 'localhost', search: '' };
    (globalThis as any).localStorage = {
      _s: {} as Record<string, string>,
      getItem(k: string) { return this._s[k] ?? null; },
      setItem(k: string, v: string) { this._s[k] = v; },
      removeItem(k: string) { delete this._s[k]; },
    };
    shim = await import('../src/renderer/remote-shim');
  });
  afterEach(() => { delete (globalThis as any).WebSocket; });

  it('does NOT send application messages while WS is CONNECTING', async () => {
    const connectPromise = shim.connect('pw', false);
    const ws = FakeWebSocket.instances[0];
    expect(ws.readyState).toBe(FakeWebSocket.CONNECTING);
    shim.installShim();
    const invokePromise = (window as any).claude.skills.list();
    expect(ws.sent).toEqual([]);
    ws.open();
    expect(ws.sent).toHaveLength(1); // auth message only
    ws.receive({ type: 'auth:ok', token: 'tok', platform: 'browser' });
    await connectPromise;
    const sentTypes = ws.sent.slice(1).map(s => JSON.parse(s).type);
    expect(sentTypes).toContain('skills:list');
    const queuedMsg = JSON.parse(ws.sent[ws.sent.length - 1]);
    ws.receive({ type: 'skills:list:response', id: queuedMsg.id, payload: [] });
    await expect(invokePromise).resolves.toEqual([]);
  });

  it('auth message bypasses the queue (sent directly during ws.onopen)', async () => {
    shim.connect('pw', false);
    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]).type).toBe('auth');
  });

  it('drops oldest queued messages once MAX_QUEUE is exceeded (with warning)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    shim.connect('pw', false);
    const ws = FakeWebSocket.instances[0];
    shim.installShim();
    // Each invoke() call assigns a sequential id (msg-1..msg-300). After
    // overflow, the surviving 256 must be the LAST 256 enqueued — i.e.
    // msg-45..msg-300 (the first 44 dropped, oldest-first FIFO).
    for (let i = 0; i < 300; i++) (window as any).claude.skills.list();
    expect(ws.sent).toEqual([]);
    ws.open();
    ws.receive({ type: 'auth:ok', token: 't', platform: 'browser' });
    await new Promise(r => setTimeout(r, 0));
    // ws.sent[0] is the auth message; everything after is the flushed queue.
    const flushedMsgs = ws.sent.slice(1).map(s => JSON.parse(s));
    expect(flushedMsgs).toHaveLength(256);
    // FIFO drop-oldest assertion: surviving ids are the LAST 256, in order.
    const flushedIds = flushedMsgs.map(m => m.id);
    const expectedIds = Array.from({ length: 256 }, (_, i) => `msg-${45 + i}`);
    expect(flushedIds).toEqual(expectedIds);
    expect(warn).toHaveBeenCalled();
  });
});
