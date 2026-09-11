// Remote access batch 2, design §6 (T4), contract R13–R15: the shim alone knows
// where the phone's copy of the conversation stands, and says so —
// reconnecting / restoring / incomplete / complete — and Refresh re-asks the host.
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
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  sentOf(type: string) { return this.sent.map((s) => JSON.parse(s)).filter((m) => m.type === type); }
}

describe('remote:conversation-status', () => {
  let shim: typeof import('../src/renderer/remote-shim');
  let phases: string[];
  let hydrates: any[];

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    (globalThis as any).window = globalThis;
    (globalThis as any).location = { protocol: 'http:', host: 'desk:9900', search: '' };
    (globalThis as any).localStorage = {
      _s: {} as Record<string, string>,
      getItem(k: string) { return this._s[k] ?? null; },
      setItem(k: string, v: string) { this._s[k] = v; },
      removeItem(k: string) { delete this._s[k]; },
    };
    shim = await import('../src/renderer/remote-shim');
    shim.installShim();
    phases = [];
    hydrates = [];
  });
  afterEach(() => { vi.useRealTimers(); delete (globalThis as any).WebSocket; });

  const claude = () => (window as any).claude;

  /** What App does: subscribe late (after auth:ok), apply the hydrate, report what was kept. */
  function mountApp(kept: () => string[] = () => []) {
    const off = claude().on.remoteConversationStatus((s: { phase: string }) => phases.push(s.phase));
    claude().on.chatHydrate((payload: any) => {
      hydrates.push(payload);
      claude().remote.reportHydrate({ seq: payload.seq, kept: kept() });
    });
    return off;
  }

  async function firstConnect() {
    const p = shim.connect('pw', false);
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws.open();
    ws.receive({ type: 'auth:ok', deviceId: 'dev-1', secret: 's', platform: 'desktop' });
    await p;
    return ws;
  }

  it('a subscriber that mounts after auth:ok is told "restoring" at once', async () => {
    await firstConnect();
    mountApp();
    expect(phases).toEqual(['restoring']);
  });

  it('reconnecting → restoring → complete across a drop', async () => {
    const ws1 = await firstConnect();
    mountApp();
    ws1.receive({ type: 'chat:hydrate', payload: { sessions: [['s1', {}]], seq: 1 } });
    expect(phases).toEqual(['restoring', 'complete']);

    ws1.close();
    expect(phases[phases.length - 1]).toBe('reconnecting');
    vi.advanceTimersByTime(1000);
    const ws2 = FakeWebSocket.instances[1];
    ws2.open();
    ws2.receive({ type: 'auth:ok', deviceId: 'dev-1', platform: 'desktop' });
    await Promise.resolve();
    expect(phases[phases.length - 1]).toBe('restoring');
    ws2.receive({ type: 'chat:hydrate', payload: { sessions: [['s1', {}]], seq: 2 } });
    expect(phases).toEqual(['restoring', 'complete', 'reconnecting', 'restoring', 'complete']);
  });

  it('a degraded hydrate is incomplete', async () => {
    const ws = await firstConnect();
    mountApp();
    ws.receive({ type: 'chat:hydrate', payload: { sessions: [['s1', {}]], seq: 1, degraded: true } });
    expect(phases[phases.length - 1]).toBe('incomplete');
  });

  it('a hydrate that left any session kept from before is incomplete', async () => {
    const ws = await firstConnect();
    mountApp(() => ['s2']);
    ws.receive({ type: 'chat:hydrate', payload: { sessions: [['s1', {}]], seq: 1 } });
    expect(phases[phases.length - 1]).toBe('incomplete');
  });

  it('no hydrate within 10 s of client:ready is incomplete', async () => {
    const ws = await firstConnect();
    mountApp();
    expect(ws.sentOf('client:ready')).toHaveLength(1);
    vi.advanceTimersByTime(9_999);
    expect(phases).toEqual(['restoring']);
    vi.advanceTimersByTime(1);
    expect(phases).toEqual(['restoring', 'incomplete']);
  });

  it('Refresh re-enters restoring with the next seq; the stale hydrate is ignored; the new one completes', async () => {
    const ws = await firstConnect();
    mountApp();
    ws.receive({ type: 'chat:hydrate', payload: { sessions: [['s1', {}]], seq: 1, degraded: true } });
    expect(phases[phases.length - 1]).toBe('incomplete');

    const refreshing = claude().remote.rehydrate();
    const req = ws.sentOf('remote:rehydrate')[0];
    expect(req.payload).toEqual({ seq: 2 });
    expect(phases[phases.length - 1]).toBe('restoring');
    ws.receive({ type: 'remote:rehydrate:response', id: req.id, payload: { ok: true } });
    await expect(refreshing).resolves.toEqual({ ok: true });

    ws.receive({ type: 'chat:hydrate', payload: { sessions: [['s1', {}]], seq: 1 } });   // a slow answer to the old ask
    expect(hydrates.map((h) => h.seq)).toEqual([1]);
    expect(phases[phases.length - 1]).toBe('restoring');
    ws.receive({ type: 'chat:hydrate', payload: { sessions: [['s1', {}]], seq: 2 } });
    expect(phases[phases.length - 1]).toBe('complete');
  });

  it('a report for a seq it did not ask for last changes nothing', async () => {
    const ws = await firstConnect();
    mountApp();
    ws.receive({ type: 'chat:hydrate', payload: { sessions: [['s1', {}]], seq: 1 } });
    claude().remote.rehydrate();
    const before = [...phases];
    claude().remote.reportHydrate({ seq: 1, kept: [] });
    expect(phases).toEqual(before);
  });

  it('an old host that sends no seq still reaches complete', async () => {
    const ws = await firstConnect();
    mountApp();
    ws.receive({ type: 'chat:hydrate', payload: { sessions: [['s1', {}]] } });
    expect(phases[phases.length - 1]).toBe('complete');
  });

  it('the unsubscribe it returns stops the pushes', async () => {
    const ws = await firstConnect();
    const off = mountApp();
    off();
    ws.receive({ type: 'chat:hydrate', payload: { sessions: [['s1', {}]], seq: 1 } });
    expect(phases).toEqual(['restoring']);
  });
});
