// The remote shim (src/renderer/remote-shim.ts) — its connection: signing in with a saved key,
// the device row it names, client:ready, noticing a silent or dead socket, and the order of
// events around a close. Run in node with fake WebSockets; see remote-shim.test.ts for the rest.
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';

// WHY each section starts with isolateGlobals(): every section below was its own file, so each
// began with a clean global object and a fresh module graph. The sections install fakes on
// globalThis (WebSocket, window, location, localStorage, document…) and not all of them remove
// every one; putting the globals back after each section, and dropping the loaded shim, keeps
// one section's fakes from leaking into the next.
const ISOLATED_GLOBALS = ['WebSocket', 'window', 'location', 'localStorage', 'document', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'claude'];
function isolateGlobals() {
  let saved: [string, PropertyDescriptor | undefined][] = [];
  beforeAll(() => { saved = ISOLATED_GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]); });
  afterAll(() => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete (globalThis as Record<string, unknown>)[k];
    }
    vi.resetModules();
  });
}

// Destin, 2026-09-11, phone pass of remote access batches 2/3: "password screen occasionally
// flickering before loading back into the thing without actually needing a password".
//
// Two faults behind it, both older than the branch. The page drew the password screen for
// as long as the saved key's sign-in took, and ANY failure of that sign-in — a phone that
// just woke with no network yet, a computer restarting — deleted the saved key, so the next
// page load really did need the password. Only the computer refusing the key may forget it.
describe('remote-shim — saved-key sign-in', () => {
  isolateGlobals();

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

    it('a computer that closes the connection during sign-in is not "unreachable", and the key stays', async () => {
      store[KEY] = 'dev-1:secret';
      start();
      latest().open();
      latest().close(4000, 'Auth timeout');
      await Promise.resolve();
      expect(events).toEqual([{ type: 'failed', kind: 'closed' }]);
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
});

// Destin, 2026-09-11: "each sign in seems to create a new device entry in the remote access
// menu? even though all the same device". The browser now remembers which row it has on each
// computer, separately from its key, and names that row when it signs in with the password, so
// losing the key never adds a row. The row id is kept per computer: another computer is never
// told it.
describe('remote-shim — device row', () => {
  isolateGlobals();

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
});

// Remote access batch 2, design §1 A (T1): the shim sends `client:ready` once
// per connection generation — the first time App's chat:hydrate listener exists
// after auth:ok — with a seq that never restarts, and drops any frame from a
// socket that is no longer the current one.
describe('remote-shim — client:ready', () => {
  isolateGlobals();

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
});

// Destin, 2026-09-11: the phone's buttons "feel unresponsive", and the dev log showed his
// phone's socket dying every 55-90 s. The computer notices a dead connection within about a
// minute; the page noticed nothing until he switched away and back, so a tap went into a socket
// that no longer existed and said nothing for the full 30 s request timeout. While the page is in
// front it now watches for silence itself, and a page that was away longer than the computer
// waits reconnects on sight instead of asking a connection that cannot answer.
describe('remote-shim — heartbeat', () => {
  isolateGlobals();

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
});

// Destin, 2026-09-11, phone pass: the new-session project list was empty, then "randomly popped
// back in". A phone that sleeps can wake holding a connection that is already dead, or sit out a
// reconnect backoff of up to 30 s, while every screen it opens asks the computer for data that
// never comes. So the phone now checks the moment it wakes: reconnect at once if it is down, and
// if it thinks it is up, ask one quick question and replace the connection if nothing answers.
describe('remote-shim — wake check', () => {
  isolateGlobals();

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
      await vi.advanceTimersByTimeAsync(10_000);
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
});

// Review of the 2026-09-11 remote reliability fixes (fresh reviewer, findings 1–4, 6, 11).
// A browser's close() only STARTS closing; the close event arrives later. These tests keep that
// order, which the other fakes in this folder collapse, because every bug here lives in the gap.
describe('remote-shim — overlapping connections', () => {
  isolateGlobals();

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
    close() { if (this.readyState === 3) return; this.readyState = 2; }
    fireClose(code = 1006) { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
    receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
    sentOf(type: string) { return this.sent.map((s) => JSON.parse(s)).filter((m) => m.type === type); }
  }

  const g = globalThis as any;
  let shim: typeof import('../src/renderer/remote-shim');
  let store: Record<string, string>;
  let doc: EventTarget & { visibilityState: string };
  const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  const claude = () => g.claude;
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

  async function setup(opts: { protocol?: string; search?: string } = {}) {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    FakeWebSocket.instances = [];
    const target = new EventTarget();
    g.WebSocket = FakeWebSocket;
    g.window = globalThis;
    g.addEventListener = target.addEventListener.bind(target);
    g.removeEventListener = target.removeEventListener.bind(target);
    g.dispatchEvent = target.dispatchEvent.bind(target);
    g.location = { protocol: opts.protocol ?? 'http:', host: 'desk:9900', search: opts.search ?? '' };
    doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    g.document = doc;
    store = {};
    g.localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    };
    await import('../src/renderer/platform');
    shim = await import('../src/renderer/remote-shim');
    shim.installShim();
  }

  async function signedIn() {
    store['youcoded-remote-token'] = 'dev-1:secret';
    const p = shim.connect('dev-1:secret', true);
    latest().open();
    latest().receive({ type: 'auth:ok', deviceId: 'dev-1', platform: 'desktop' });
    await p;
    return latest();
  }

  afterEach(() => {
    vi.useRealTimers();
    for (const k of ['WebSocket', 'document', 'addEventListener', 'removeEventListener', 'dispatchEvent']) delete g[k];
  });

  describe('an Android app paired to a computer that refuses it', () => {
    async function pairThenReconnectRefused(reason: string) {
      await setup({ protocol: 'file:', search: '?bridgeToken=bt&bridgePort=9901' });
      const pairing = shim.connectToHost('desk', 9900, 'pw');
      for (let i = 0; i < 200 && FakeWebSocket.instances.length === 0; i++) await new Promise((r) => setImmediate(r));
      const first = latest();
      expect(first.url).toBe('ws://desk:9900/ws');
      first.open();
      first.receive({ type: 'auth:ok', deviceId: 'dev-1', secret: 's', platform: 'desktop' });
      await pairing;
      first.fireClose(1006);                          // the computer went away
      await vi.advanceTimersByTimeAsync(1000);        // the app comes back with its key
      const retry = latest();
      expect(retry.url).toBe('ws://desk:9900/ws');
      retry.open();
      retry.receive({ type: 'auth:failed', reason });
      await settle();
      return retry;
    }

    it('ends up with ONE connection to its own runtime, even when the refused close arrives late', async () => {
      const refused = await pairThenReconnectRefused('revoked');
      refused.fireClose(4003);                        // the refused socket's close event, after the fallback began
      await vi.advanceTimersByTimeAsync(10_000);
      expect(FakeWebSocket.instances.filter((s) => s.url.startsWith('ws://localhost:'))).toHaveLength(1);
    });

    it('keeps the pairing when the computer only switched remote access off', async () => {
      await pairThenReconnectRefused('no-password-configured');
      expect(store['youcoded-remote-target']).toBe('ws://desk:9900/ws');
      expect(store['youcoded-remote-token']).toBe('dev-1:s');
      expect(FakeWebSocket.instances.filter((s) => s.url.startsWith('ws://localhost:'))).toHaveLength(0);
    });
  });

  // The Android app's saved computers live in its own runtime, but while it is paired its one
  // connection talks to the computer, which has no such list. Removing a computer then answered
  // "done" and changed nothing: the pairing (address and password) stayed on the phone.
  describe('an Android app paired to a computer edits the saved computers on the phone', () => {
    async function paired() {
      await setup({ protocol: 'file:', search: '?bridgeToken=bt&bridgePort=9901' });
      const pairing = shim.connectToHost('desk', 9900, 'pw');
      for (let i = 0; i < 200 && FakeWebSocket.instances.length === 0; i++) await new Promise((r) => setImmediate(r));
      const desk = latest();
      desk.open();
      desk.receive({ type: 'auth:ok', deviceId: 'dev-1', secret: 's', platform: 'desktop' });
      await pairing;
      return desk;
    }

    it('removing a computer goes to the phone’s own runtime, which answers it', async () => {
      const desk = await paired();
      const removing = claude().android.removePairedDevice('desk', 9900);
      const local = latest();
      expect(local).not.toBe(desk);
      expect(local.url).toBe('ws://localhost:9901');
      local.open();
      expect(local.sentOf('auth')).toEqual([{ type: 'auth', token: 'bt' }]);
      local.receive({ type: 'auth:ok', platform: 'android' });
      const [req] = local.sentOf('android:remove-paired-device');
      expect(req.payload).toEqual({ host: 'desk', port: 9900 });
      local.receive({ type: 'android:remove-paired-device:response', id: req.id, payload: true });
      await expect(removing).resolves.toBe(true);
      expect(local.readyState).not.toBe(FakeWebSocket.OPEN);     // the short connection is closed
      expect(desk.sentOf('android:remove-paired-device')).toHaveLength(0);
      expect(claude().session.canSend()).toBe(true);             // the computer connection is untouched
    });

    it('the list and a save reach the phone too', async () => {
      await paired();
      const listing = claude().android.getPairedDevices();
      const local = latest();
      local.open();
      local.receive({ type: 'auth:ok', platform: 'android' });
      const [req] = local.sentOf('android:get-paired-devices');
      local.receive({ type: 'android:get-paired-devices:response', id: req.id, payload: { devices: [{ host: 'desk', port: 9900 }] } });
      await expect(listing).resolves.toEqual({ devices: [{ host: 'desk', port: 9900 }] });

      const saving = claude().android.savePairedDevice({ name: 'Desk', host: 'desk', port: 9900, password: 'pw' });
      const local2 = latest();
      local2.open();
      local2.receive({ type: 'auth:ok', platform: 'android' });
      const [save] = local2.sentOf('android:save-paired-device');
      local2.receive({ type: 'android:save-paired-device:response', id: save.id, payload: true });
      await expect(saving).resolves.toBe(true);
    });

    it('a phone runtime that never answers fails the call instead of pretending it worked', async () => {
      await paired();
      const removing = claude().android.removePairedDevice('desk', 9900);
      latest().fireClose(1006);
      await expect(removing).rejects.toThrow();
    });
  });

  // The computer tells every client `platform: 'desktop'`. A phone browser adopted it and so
  // was never treated as a touch device: its terminal took typing through xterm's own hidden
  // box (the soft keyboard and scrolling misbehaved). The DEVICE decides; the host's word
  // stays for a mouse-first screen, so a laptop browser behaves as it always has.
  describe('the platform a browser reports after signing in', () => {
    async function signInWithPointer(coarse: boolean) {
      await setup();
      g.matchMedia = (q: string) => ({ matches: coarse && q === '(pointer: coarse)' });
      delete g.__PLATFORM__;
      const p = shim.connect('pw', false);
      latest().open();
      latest().receive({ type: 'auth:ok', deviceId: 'dev-1', secret: 's', platform: 'desktop' });
      await p;
    }
    afterEach(() => { delete g.matchMedia; delete g.__PLATFORM__; });

    it('a phone (touch first) is a touch browser, not the computer it talks to', async () => {
      await signInWithPointer(true);
      expect(g.__PLATFORM__).toBe('browser');
    });

    it('a mouse-first browser keeps what the computer said', async () => {
      await signInWithPointer(false);
      expect(g.__PLATFORM__).toBe('desktop');
    });
  });

  describe('an older connection attempt cannot disturb a newer one', () => {
    it('"Enter password instead", then the old attempt gets through: still connected, still able to send', async () => {
      await setup();
      store['youcoded-remote-token'] = 'dev-1:secret';
      shim.startSavedKeySignIn(() => {});
      const stale = latest();                         // no network yet: stuck connecting
      shim.stopSavedKeySignIn();
      const login = shim.connect('pw', false);
      const fresh = latest();
      fresh.open();
      fresh.receive({ type: 'auth:ok', deviceId: 'dev-2', secret: 's2', platform: 'desktop' });
      await login;
      stale.open();                                   // the old attempt finally opens
      stale.fireClose(4000);                          // and the host's auth timeout closes it
      await vi.advanceTimersByTimeAsync(20_000);      // past its own 15 s connect timeout
      expect(claude().session.canSend()).toBe(true);
      expect(fresh.sentOf('auth')).toHaveLength(1);
    });
  });

  describe('the wake check does not replace a connection that is working', () => {
    it('anything arriving from the computer after the check counts as an answer', async () => {
      await setup();
      const ws = await signedIn();
      doc.dispatchEvent(new Event('visibilitychange'));
      expect(ws.sentOf('remote:ping')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(3_000);
      ws.receive({ type: 'status:data', payload: {} }); // a catch-up in progress, arriving ahead of the reply
      await vi.advanceTimersByTimeAsync(10_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('waits 10 s of silence, not 5, before replacing it', async () => {
      await setup();
      await signedIn();
      doc.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(9_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(FakeWebSocket.instances).toHaveLength(2);
    });
  });

  describe('requests cut off by a drop', () => {
    it('fail at once, and the reconnect asks the computer whether they ran', async () => {
      await setup();
      const ws = await signedIn();
      let outcome = 'pending';
      claude().skills.list().then(() => { outcome = 'resolved'; }, (e: Error) => { outcome = e.message; });
      const req = ws.sentOf('skills:list')[0];
      ws.fireClose(1006);
      await settle();
      expect(outcome).toBe('Lost the connection before the computer answered.');
      await vi.advanceTimersByTimeAsync(1000);
      const back = latest();
      back.open();
      back.receive({ type: 'auth:ok', deviceId: 'dev-1', platform: 'desktop' });
      await settle();
      expect(back.sentOf('remote:request-outcome')[0]?.payload.ids).toContain(req.id);
    });
  });

  describe('the network coming back', () => {
    it('before the first sign-in, tries the saved key at once instead of waiting out the retry', async () => {
      await setup();
      store['youcoded-remote-token'] = 'dev-1:secret';
      shim.startSavedKeySignIn(() => {});
      latest().fireClose(1006);                       // no network
      await settle();
      expect(FakeWebSocket.instances).toHaveLength(1);
      g.dispatchEvent(new Event('online'));
      expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it('the real online and pageshow events run the check; a normal page load does not', async () => {
      await setup();
      const ws = await signedIn();
      g.dispatchEvent(new Event('online'));
      const first = ws.sentOf('remote:ping');
      expect(first).toHaveLength(1);
      ws.receive({ type: 'remote:ping:response', id: first[0].id, payload: { ok: true } });
      g.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
      expect(ws.sentOf('remote:ping')).toHaveLength(1);
      g.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
      expect(ws.sentOf('remote:ping')).toHaveLength(2);
    });
  });

  describe('a computer that stops accepting this device after it connected', () => {
    it('says so when the reconnect is refused', async () => {
      await setup();
      const refusals: string[] = [];
      shim.onCredentialRefused((r) => refusals.push(r));
      const ws = await signedIn();
      ws.fireClose(1006);
      await vi.advanceTimersByTimeAsync(1000);
      latest().open();
      latest().receive({ type: 'auth:failed', reason: 'revoked' });
      await settle();
      expect(refusals).toEqual(['revoked']);
    });

    it('says so when it unpairs the device while connected', async () => {
      await setup();
      const refusals: string[] = [];
      shim.onCredentialRefused((r) => refusals.push(r));
      const ws = await signedIn();
      ws.fireClose(4003);
      expect(refusals).toEqual(['revoked']);
    });
  });
});
