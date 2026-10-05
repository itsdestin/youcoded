// A phone browser that kept an OLD page open while the computer updated (one-core R5-2 follow-up). The real v1.3.0 connection code
// (tests/fixtures/old-remote-shim) is driven against the real new host: what does the old page get, and what does it show?
// The old page waits for a `chat:hydrate` snapshot that is gone; nothing in it reloads itself on a close code, and its handling of
// 4005 shows the password box with no message and loops. So the host answers it the way it understands.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1; static CONNECTING = 0;
  readyState = 0; sent: string[] = [];
  onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  send(d: string) { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(d); }
  close(code = 1000, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(m: any) { this.onmessage?.({ data: JSON.stringify(m) }); }
  sentOf(t: string) { return this.sent.map((s) => JSON.parse(s)).filter((m) => m.type === t); }
}
class HostSocket extends EventEmitter {
  frames: any[] = []; readyState = 1; bufferedAmount = 0;
  send(raw: string) { this.frames.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  ping() {}
}

describe('an old phone page against the new host', () => {
  let oldShim: any;
  beforeEach(async () => {
    vi.resetModules();
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    (globalThis as any).window = globalThis;
    (globalThis as any).location = { protocol: 'http:', host: 'desk:9900', search: '' };
    const store: Record<string, string> = {};
    (globalThis as any).localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } };
    const bus = new EventTarget();
    (globalThis as any).addEventListener = bus.addEventListener.bind(bus);
    (globalThis as any).removeEventListener = bus.removeEventListener.bind(bus);
    (globalThis as any).dispatchEvent = bus.dispatchEvent.bind(bus);
    oldShim = await import('./fixtures/old-remote-shim/remote-shim');
    oldShim.installShim();
  });
  afterEach(() => { delete (globalThis as any).WebSocket; vi.resetModules(); });

  async function host() {
    const { RemoteServer } = await import('../src/main/remote-server');
    const sm = Object.assign(new EventEmitter(), { listSessions: vi.fn(() => [{ id: 's1', name: 'one', cwd: '/x', status: 'active' }, { id: 's2', name: 'two', cwd: '/x', status: 'active' }]) });
    const server: any = new RemoteServer(sm as never, new EventEmitter() as never, { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) } as never, undefined, { getFocusSessionId: () => 's2' });
    const ws = new HostSocket();
    server.addClient(ws, 'dev', '1.2.3.4');
    return { server, ws };
  }

  it('the old page asks for a snapshot with a seq and no version, and the new host answers it with the session list and a degraded snapshot holding one refresh notice per conversation', async () => {
    const p = oldShim.connect('pw', false);
    const sock = FakeWebSocket.instances[0];
    sock.open();
    sock.receive({ type: 'auth:ok', deviceId: 'd', secret: 's', platform: 'desktop' });
    await p;
    const phases: string[] = []; const hydrates: any[] = []; const created: string[] = [];
    (window as any).claude.on.remoteConversationStatus((s: any) => phases.push(s.phase));
    (window as any).claude.on.sessionCreated((s: any) => created.push(s.id));
    (window as any).claude.on.chatHydrate((payload: any) => { hydrates.push(payload); (window as any).claude.remote.reportHydrate({ seq: payload.seq, kept: [] }); });
    const ready = sock.sentOf('client:ready')[0];
    expect(ready.payload.seq).toBeDefined();
    expect(ready.payload.protocolVersion).toBeUndefined();          // what makes it recognisable as old

    const { ws } = await host();
    ws.emit('message', JSON.stringify(ready));
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    expect(ws.frames.map((f) => f.type)).toEqual(['session:created', 'session:created', 'chat:hydrate']);
    for (const f of ws.frames) sock.receive(f);                       // hand them to the REAL old page

    expect(created).toEqual(['s1', 's2']);
    expect(hydrates).toHaveLength(1);
    expect(hydrates[0].degraded).toBe(true);
    expect(hydrates[0].focus).toEqual({ sessionId: 's2' });
    expect(hydrates[0].sessions.map(([id]: any) => id)).toEqual(['s1', 's2']);
    for (const [, s] of hydrates[0].sessions) expect(s.timeline).toEqual([expect.objectContaining({ kind: 'system-marker', marker: expect.objectContaining({ label: 'Refresh this page to finish updating' }) })]);
    // its own strip: restoring, then "may be out of date" with its Refresh button (a degraded snapshot is incomplete)
    expect(phases).toEqual(['restoring', 'incomplete']);
  });

  it('a page that names an old protocol version is refused with 4005 and the plain reason (a future bump explains itself in the new gate)', async () => {
    const { ws } = await host();
    const close = vi.spyOn(ws, 'close');
    ws.emit('message', JSON.stringify({ type: 'client:ready', payload: { reconnect: false, protocolVersion: 1 } }));
    await new Promise((r) => setImmediate(r));
    expect(close).toHaveBeenCalledWith(4005, expect.stringContaining('older than your computer'));
  });

  it('index.html is served no-cache, so reloading the tab fetches the new page', async () => {
    const { cacheControlFor } = await import('../src/main/remote-static-policy');
    expect(cacheControlFor('/index.html')).toBe('no-cache');
    expect(cacheControlFor('/')).toBe('no-cache');
  });
});
