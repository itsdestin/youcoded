// The remote shim (src/renderer/remote-shim.ts) — the browser/phone side of the remote bridge:
// what it sends, queues and re-asks, and what it tells the page. Run in node with a fake
// WebSocket. Sibling files: remote-shim-connection (signing in, noticing a dead socket),
// remote-shim-refusals and remote-shim-files (both need jsdom).
import { describe, expect, it, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  responseOutcome,
  REJECT_ON_NOT_OK,
  MESSAGE_KIND,
} from '../src/renderer/remote-shim';
import { readSource } from './helpers/guard-scope';

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

describe('remote-shim — host administration', () => {
  isolateGlobals();

  // Two, not three: `remote:disconnect-client` is no longer answered here at all. It kept a
  // refusing case so an un-upgraded client would be told no, but a shim only turns `{ok:false}`
  // into an error for channels in its own REJECT_ON_NOT_OK, and none lists that one — so the
  // refusal read as success. `default:` answers `{unsupported:true}`, which every shim rejects.
  const ADMIN = ['remote:set-password', 'remote:set-config'];

  // WHY no source reads here any more (Plan B, 2026-09-16): that the server keeps a refusing
  // case for each admin channel, never compares client.ip to 127.0.0.1, still answers
  // remote:get-config, and that SettingsPanel's Unpair button carries disabled={hostOnly} are
  // the ast-grep rules remote-admin-case-refuses and unpair-button-disabled-on-remote.
  describe('host administration does not travel over the remote socket', () => {
    it('the refusal reaches the caller as a failure, not as a success', () => {
      // Without this the phone showed the password field's success tick for a change the
      // host refused — a false success on the surface where it matters most.
      // The two device channels joined this list after a review found the same false success
      // on Unpair: the row vanished from the list while the device kept full access.
      for (const channel of [...ADMIN, 'remote:devices:rename', 'remote:devices:unpair']) {
        expect(REJECT_ON_NOT_OK.has(channel)).toBe(true);
        expect(responseOutcome(channel, { ok: false, error: 'x' })).toBe('failure');
      }
    });

    it('reading the configuration is still allowed', () => {
      // Only CHANGING the host is refused; a phone still shows you its state.
      expect(responseOutcome('remote:get-config', { enabled: true })).toBe('value');
    });
  });
});

describe('remote-shim — message kinds', () => {
  isolateGlobals();

  const shim = readSource(fileURLToPath(new URL('../src/renderer/remote-shim.ts', import.meta.url)));

  /** Every channel the shim sends without expecting a reply — the ones that could be queued. */
  function firedChannels(): string[] {
    return [...shim.matchAll(/\bfire\('([^']+)'/g)].map(m => m[1]).sort();
  }

  describe('nothing sends itself', () => {
    it('every fire-and-forget channel is classified', () => {
      // WHY a guard and not a convention: the way this regresses is a new channel added
      // without a kind, silently defaulting to the queue — which is exactly the behaviour
      // contract row R2 forbids.
      const unclassified = firedChannels().filter(c => !MESSAGE_KIND[c]);
      expect(unclassified).toEqual([]);
    });

    it('the scan finds real channels, so an empty result cannot pass vacuously', () => {
      expect(firedChannels()).toContain('session:input');
      expect(firedChannels()).toContain('native:interrupt');
    });

    it('typing and handoff attempts are user actions, never queued', () => {
      for (const c of ['session:input', 'native:retry', 'native:interrupt', 'ui:action',
        'handoff:begin', 'handoff:status', 'handoff:wait', 'handoff:retry',
        'handoff:saved-copy', 'handoff:force', 'handoff:cancel', 'handoff:create-params']) {
        expect(MESSAGE_KIND[c]).toBe('user-action');
      }
      // The refusal path: send() returns false for a user action rather than queueing it.
      expect(shim).toContain("if (MESSAGE_KIND[msg?.type] === 'user-action') return false;");
    });

    it('the composer asks whether it can send instead of writing to find out', () => {
      const bar = readSource(fileURLToPath(new URL('../src/renderer/components/InputBar.tsx', import.meta.url)));
      expect(bar).toContain('window.claude.session.canSend?.() === false');
      // Both bridges answer it, so the composer never has to know which one it holds.
      expect(readSource(fileURLToPath(new URL('../src/main/preload.ts', import.meta.url)))).toContain('canSend: () => true');
      expect(shim).toContain('canSend: () =>');
    });
  });
});

describe('remote-shim — send queue', () => {
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

    it('rejects offline handoff actions immediately without replaying or retaining their request timeout', async () => {
      const connectPromise = shim.connect('pw', false);
      const ws = FakeWebSocket.instances[0];
      shim.installShim();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const before = vi.getTimerCount();
        const attempt = (window as any).claude.session.handoff.force('attempt', true, 'original');
        await expect(attempt).rejects.toThrow(/connection|offline|unavailable/i);
        expect(vi.getTimerCount()).toBe(before);
        ws.open(); ws.receive({ type: 'auth:ok', token: 'tok', platform: 'browser' });
        await connectPromise;
        expect(ws.sent.map(raw => JSON.parse(raw).type)).not.toContain('handoff:force');
      } finally { vi.useRealTimers(); }
    });

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

    it('drops a queued message whose caller was already told it failed', async () => {
      // The queue exists so a FIRST connect works: mount-time reads fire before auth and
      // would otherwise be lost. But it was replaying EVERYTHING, including requests that
      // had timed out thirty seconds earlier and told the user they failed — so an action
      // you were told did not happen could happen minutes later, once the phone reconnected.
      // Only the CLOCK is faked, not timers: the shim's own connect timeout is a real
      // setTimeout, and fast-forwarding it would close the socket before the flush.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        shim.connect('pw', false);
        const ws = FakeWebSocket.instances[0];
        shim.installShim();

        // One request queued while the socket is still connecting...
        (window as any).claude.skills.list().catch(() => {});
        // ...then more than the 30s request timeout passes, so its caller has already been
        // told it failed and nobody is waiting for it any more.
        vi.setSystemTime(Date.now() + 31_000);
        (window as any).claude.commands.list().catch(() => {});

        ws.open();
        ws.receive({ type: 'auth:ok', token: 'tok', platform: 'browser' });
        await Promise.resolve();

        const flushed = ws.sent.slice(1).map(s => JSON.parse(s).type);
        expect(flushed).toContain('commands:list');
        expect(flushed).not.toContain('skills:list');
      } finally {
        vi.useRealTimers();
      }
    });

    it('auth message bypasses the queue (sent directly during ws.onopen)', async () => {
      shim.connect('pw', false);
      const ws = FakeWebSocket.instances[0];
      ws.open();
      expect(ws.sent).toHaveLength(1);
      expect(JSON.parse(ws.sent[0]).type).toBe('auth');
    });

    it('clears the queue on host change so messages do not leak across hosts', async () => {
      // Cold-start race: messages enqueue while authenticating to a remote.
      // If that remote auth fails and we fall back to the local bridge, the
      // queued messages must NOT flush to the local bridge — they were
      // bound for the failed remote.
      shim.installShim();

      // Initiate connect to a remote directly. connectToHost calls disconnect()
      // first (no-op since no prior ws), then sets targetUrl and connects.
      const remoteConnect = shim.connectToHost('192.168.1.100', 9900, 'remote-pw');
      // Let the async checkTailscaleIfNeeded + dynamic import('./platform')
      // microtasks resolve so the new WS instance is created. The dynamic
      // import() needs more than one microtask to settle on first invocation
      // — wait until a FakeWebSocket actually gets constructed.
      while (FakeWebSocket.instances.length === 0) {
        await new Promise(r => setTimeout(r, 0));
      }

      // The connectToHost call disconnects (no-op) then opens a new WS to
      // the remote. Open the WS so ws.onopen sends the auth message and
      // state transitions to 'authenticating'.
      const remoteWs = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      remoteWs.open();  // ws.onopen → sends auth message, sets state to 'authenticating'
      // Now in authenticating state — fire some application sends. These
      // get queued because send() requires connectionState === 'connected'.
      // Catch the resulting invoke promises to avoid unhandled rejections
      // when pending.clear() triggers on the next host switch (or test end).
      (window as any).claude.skills.list().catch(() => {});
      (window as any).claude.skills.list().catch(() => {});

      // Remote auth fails — server replies auth:failed. The auth:failed
      // handler rejects, then calls ws.close() which triggers ws.onclose
      // (post-auth branch). connectToHost's catch block then fires.
      const beforeFailCount = FakeWebSocket.instances.length;
      remoteWs.receive({ type: 'auth:failed', reason: 'bad-password' });
      await remoteConnect.catch(() => {}); // expected to throw
      // Wait for the catch block's `connect('android-local')` to construct
      // its WebSocket (synchronous inside the Promise constructor, but the
      // catch block itself runs as a microtask after the await rejects).
      while (FakeWebSocket.instances.length === beforeFailCount) {
        await new Promise(r => setTimeout(r, 0));
      }

      // The catch block clears the queue (the fix under test) and falls
      // back to connect('android-local'). The fallback WS is now the
      // latest FakeWebSocket instance.
      const fallbackWs = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      fallbackWs.open();
      fallbackWs.receive({ type: 'auth:ok', token: 'local-tok', platform: 'browser' });
      await new Promise(r => setTimeout(r, 0));

      // After auth:ok, flushSendQueue ran. The fallback WS should have ONLY
      // the auth message — the two pre-fallback application messages must
      // NOT have been flushed to it (they were bound for the failed remote).
      const fallbackTypes = fallbackWs.sent.map(s => JSON.parse(s).type);
      expect(fallbackTypes).toEqual(['auth']);
      expect(fallbackTypes).not.toContain('skills:list');
    });

    it('drops oldest queued messages once MAX_QUEUE is exceeded (with warning)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      shim.connect('pw', false);
      const ws = FakeWebSocket.instances[0];
      shim.installShim();
      // Each invoke() call assigns a sequential id. The counter is now prefixed with the
      // device and the connection generation, because `msg-N` alone came from a per-page-load
      // counter: two devices, or one device after a reload, produced the same ids and the
      // host could answer "did this run?" about somebody else's request. The FIFO behaviour
      // under test is unchanged — the surviving 256 are the LAST 256 enqueued.
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
      const expectedIds = Array.from({ length: 256 }, (_, i) => `anon:1:${45 + i}`);
      expect(flushedIds).toEqual(expectedIds);
      expect(warn).toHaveBeenCalled();
    });
  });
});

describe('remote-shim — loadHistory arguments', () => {
  isolateGlobals();

  // Regression test for the loadHistory argument-order parity bug (PR #300 review):
  // the shim declared (sessionId, count, all, projectSlug) while preload.ts and
  // every renderer caller (App.tsx, ChatView.tsx, useIpc.ts) use
  // (sessionId, projectSlug, count, all). On remote browsers and Android the
  // project slug string landed in `count` and 10 landed in `all` (truthy), so
  // session-browser's `if (all) return messages` shipped the ENTIRE transcript
  // over the WebSocket on every initial history load. This test drives the shim
  // with the canonical caller order and asserts each field lands in the right
  // payload slot on the wire.

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

  describe('remote-shim loadHistory argument order', () => {
    let shim: typeof import('../src/renderer/remote-shim');
    let ws: FakeWebSocket;

    beforeEach(async () => {
      const { vi } = await import('vitest');
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
      const connectPromise = shim.connect('pw', false);
      ws = FakeWebSocket.instances[0];
      ws.open();
      ws.receive({ type: 'auth:ok', token: 'tok', platform: 'browser' });
      await connectPromise;
      shim.installShim();
    });

    afterEach(() => { delete (globalThis as any).WebSocket; });

    it('initial-load call (App.tsx order) places every field in its own payload slot', async () => {
      // Canonical caller order — identical to App.tsx's initial history load and
      // to preload.ts's signature: (sessionId, projectSlug, count, all).
      const p = (window as any).claude.session.loadHistory('abc-123', 'my-project', 10, false);
      const msg = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(msg.type).toBe('session:history');
      expect(msg.payload).toEqual({
        sessionId: 'abc-123',
        projectSlug: 'my-project',
        count: 10,
        all: false,
      });
      ws.receive({ type: 'session:history:response', id: msg.id, payload: [] });
      await expect(p).resolves.toEqual([]);
    });

    it('expand-all call (ChatView order) sends all:true and a numeric count', async () => {
      // ChatView's "See previous messages" passes (id, slug, 0, true). The shim
      // mirrors preload's `count || 10` / `all || false` defaults so the wire
      // always carries real number/boolean types (Android's optInt/optBoolean
      // and the server's slice(-count) both require them).
      const p = (window as any).claude.session.loadHistory('abc-123', 'my-project', 0, true);
      const msg = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(msg.type).toBe('session:history');
      expect(msg.payload).toEqual({
        sessionId: 'abc-123',
        projectSlug: 'my-project',
        count: 10, // 0 || 10 — parity with preload's default; ignored when all=true
        all: true,
      });
      ws.receive({ type: 'session:history:response', id: msg.id, payload: [] });
      await expect(p).resolves.toEqual([]);
    });
  });
});

// Remote access batch 2, T2 review finding 1: the device that answers a permission
// must not show "Answered on the computer" on its own answer. For a NATIVE ask the host
// announces the resolution before it replies to the answer, so the resolution reaches
// the answering phone first; the shim knows which answers it has in flight and keeps
// that one resolution from the page. (A Claude Code ask replies first — the relay
// announces on a microtask — and the card is already answered when the resolution
// lands, so the reducer ignores it.) Every other device still gets it.
describe('remote-shim — permission answers in flight', () => {
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
    close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
    receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
    sentOf(type: string) { return this.sent.map((s) => JSON.parse(s)).filter((m) => m.type === type); }
  }

  describe('a permission answered from this phone', () => {
    let shim: typeof import('../src/renderer/remote-shim');
    let ws: FakeWebSocket;
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
      const p = shim.connect('pw', false);
      ws = FakeWebSocket.instances[0];
      ws.open();
      ws.receive({ type: 'auth:ok', deviceId: 'dev-1', secret: 's', platform: 'desktop' });
      await p;
    });
    afterEach(() => { delete (globalThis as any).WebSocket; });

    const resolved = (requestId: string) => ({ type: 'hook:event', payload: { type: 'PermissionResolved', sessionId: 's1', payload: { _requestId: requestId }, timestamp: 1 } });

    it('keeps the resolution of its own in-flight answer from the page, and only that one', async () => {
      const seen: string[] = [];
      (window as any).claude.on.hookEvent((e: any) => seen.push(`${e.type}:${e.payload._requestId}`));
      const answer = (window as any).claude.session.respondToPermission('mine', { decision: { behavior: 'allow' } });
      const req = ws.sentOf('permission:respond')[0];

      ws.receive(resolved('mine'));      // arrives BEFORE the reply — a native ask's order
      ws.receive(resolved('theirs'));
      expect(seen).toEqual(['PermissionResolved:theirs']);

      ws.receive({ type: 'permission:respond:response', id: req.id, payload: true });
      await expect(answer).resolves.toBe(true);
      ws.receive(resolved('mine'));      // a later copy (a replay) is no longer ours to hide
      expect(seen).toEqual(['PermissionResolved:theirs', 'PermissionResolved:mine']);
    });
  });
});

// Remote access batch 2, design §1 C and §7 (T2): the shim keeps terminal
// frames that arrive before the terminal is mounted, in order and bounded, and
// reports how much of each session's terminal it has drawn so a reconnect sends
// only what is missing.
describe('remote-shim — terminal backlog', () => {
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
    close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
    receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
    sentOf(type: string) { return this.sent.map((s) => JSON.parse(s)).filter((m) => m.type === type); }
  }

  describe('remote-shim terminal backlog and offsets', () => {
    let shim: typeof import('../src/renderer/remote-shim');
    let ws: FakeWebSocket;
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
      const p = shim.connect('pw', false);
      ws = FakeWebSocket.instances[0];
      ws.open();
      ws.receive({ type: 'auth:ok', deviceId: 'dev-1', secret: 's', platform: 'desktop' });
      await p;
    });
    afterEach(() => { vi.useRealTimers(); delete (globalThis as any).WebSocket; });

    /** What App does for each conversation: ask the computer to fill it (the answer lets that session's live terminal frames through). */
    async function openIt(sock: FakeWebSocket, sessionId: string, answer: Record<string, unknown> = {}) {
      const pending = (window as any).claude.session.open({ sessionId, ...(answer.__req as object ?? {}) });
      const req = sock.sentOf('session:open').at(-1);
      sock.receive({ type: 'session:open:response', id: req.id, payload: { ok: true, epoch: 'E', headSeq: 0, resume: 'page', before: [], page: null, after: [], facts: { working: false, attention: 'ok' }, ...answer } });
      await pending;
      return req;
    }
    const output = (sessionId: string, data: string, offset: number, epoch = 'e1') =>
      ws.receive({ type: 'pty:output', payload: { sessionId, data, epoch, offset } });

    it('drops a live terminal frame for a conversation it has not opened on this connection (an answer carries the bytes up to its cut)', async () => {
      const seen: string[] = [];
      (window as any).claude.on.ptyOutputForSession('s1', (d: string) => seen.push(d));
      output('s1', 'too early', 0);
      expect(seen).toEqual([]);
      await openIt(ws, 's1');
      output('s1', 'now', 0);
      expect(seen).toEqual(['now']);
    });

    it('delivers pty:output and pty:reset that arrived before any listener, in order, on the first listener', async () => {
      await openIt(ws, 's1');
      output('s1', 'old ', 0);
      ws.receive({ type: 'pty:reset', payload: { sessionId: 's1', epoch: 'e2' } });
      output('s1', 'fresh', 0, 'e2');

      const seen: string[] = [];
      (window as any).claude.on.ptyResetForSession('s1', () => seen.push('<RESET>'));
      expect(seen).toEqual([]);                                   // the reset listener alone does not drain
      (window as any).claude.on.ptyOutputForSession('s1', (d: string) => seen.push(d));
      expect(seen).toEqual(['old ', '<RESET>', 'fresh']);

      output('s1', ' live', 5, 'e2');                             // after the drain, frames go straight through
      expect(seen).toEqual(['old ', '<RESET>', 'fresh', ' live']);
    });

    it('keeps the backlog per session', async () => {
      await openIt(ws, 's1'); await openIt(ws, 's2');
      output('s1', 'one', 0);
      output('s2', 'two', 0);
      const s2: string[] = [];
      (window as any).claude.on.ptyOutputForSession('s2', (d: string) => s2.push(d));
      expect(s2).toEqual(['two']);
      const s1: string[] = [];
      (window as any).claude.on.ptyOutputForSession('s1', (d: string) => s1.push(d));
      expect(s1).toEqual(['one']);
    });

    it('caps the backlog at 256 KB of units by trimming the OLDEST output, keeping its tail and everything after', async () => {
      await openIt(ws, 's1');
      const replay = 'old-line\n'.repeat(40 * 1024);              // 360 KB, line-shaped
      output('s1', replay, 0);
      output('s1', 'live', replay.length);
      const seen: string[] = [];
      (window as any).claude.on.ptyOutputForSession('s1', (d: string) => seen.push(d));
      const total = seen.reduce((n, d) => n + d.length, 0);
      expect(total).toBeLessThanOrEqual(256 * 1024);
      expect(seen[seen.length - 1]).toBe('live');
      expect(seen[0].startsWith('old-line\n')).toBe(true);        // cut at a line break, not mid-line
      expect(replay.endsWith(seen[0])).toBe(true);                   // the TAIL of the replay survived
    });

    it('a reconnect\'s session:open says how far each terminal drew, per session, and 0 after a reset', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await openIt(ws, 's1'); await openIt(ws, 's2');
      output('s1', 'abc', 0);
      output('s1', 'de', 3);
      output('s2', 'zzzz', 0, 'e9');
      ws.receive({ type: 'pty:reset', payload: { sessionId: 's2', epoch: 'e10' } });
      ws.receive({ type: 'session:destroyed', payload: { sessionId: 's3', exitCode: 0 } });

      ws.close();
      vi.advanceTimersByTime(1000);
      const ws2 = FakeWebSocket.instances[1];
      ws2.open();
      ws2.receive({ type: 'auth:ok', deviceId: 'dev-1', platform: 'desktop' });
      await Promise.resolve();
      const r1 = await openIt(ws2, 's1');
      const r2 = await openIt(ws2, 's2');
      expect(r1.payload.pty).toEqual({ epoch: 'e1', units: 5 });
      expect(r2.payload.pty).toEqual({ epoch: 'e10', units: 0 });
    });

    it('applies the terminal bytes an answer carries (a reset first when the host could not continue), then continues from them', async () => {
      const seen: string[] = [];
      (window as any).claude.on.ptyResetForSession('s1', () => seen.push('<RESET>'));
      (window as any).claude.on.ptyOutputForSession('s1', (d: string) => seen.push(d));
      await openIt(ws, 's1', { pty: { epoch: 'E', offset: 0, data: 'screen so far', reset: true } });
      expect(seen).toEqual(['<RESET>', 'screen so far']);
      output('s1', ' + live', 13, 'E');
      expect(seen).toEqual(['<RESET>', 'screen so far', ' + live']);
    });

    it('a frame that overlaps what an answer already carried is drawn only past it (no doubled text)', async () => {
      const seen: string[] = [];
      (window as any).claude.on.ptyOutputForSession('s1', (d: string) => seen.push(d));
      await openIt(ws, 's1', { pty: { epoch: 'E', offset: 0, data: 'hello world', reset: false } });
      output('s1', 'o world!!', 4, 'E');            // began at 4: only the "!!" is new
      output('s1', 'hello', 0, 'E');                // wholly inside: nothing
      expect(seen).toEqual(['hello world', '!!']);
    });

    it('unwatching a conversation tells the computer, drops any terminal frame still on the wire, and keeps its place for next time', async () => {
      await openIt(ws, 's1', { epoch: 'E', headSeq: 7 });
      output('s1', 'abc', 0);
      const seen: string[] = [];
      (window as any).claude.on.ptyOutputForSession('s1', (d: string) => seen.push(d));
      expect(seen).toEqual(['abc']);
      const done = (window as any).claude.session.unwatch('s1');
      const req = ws.sentOf('session:unwatch').at(-1);
      expect(req.payload).toEqual({ sessionId: 's1' });
      ws.receive({ type: 'session:unwatch:response', id: req.id, payload: { ok: true } });
      await expect(done).resolves.toEqual({ ok: true });
      output('s1', 'late frame', 3);
      expect(seen).toEqual(['abc']);                                   // dropped: not watched
      // Opening it again says where it got to, so the computer sends only what it missed.
      const again = await openIt(ws, 's1');
      expect(again.payload.have).toEqual({ epoch: 'E', seq: 7 });
      expect(again.payload.pty).toEqual({ epoch: 'e1', units: 3 });
    });

    it('Refresh forgets where it got to in the conversations it is NOT watching, so they take a fresh page when next opened', async () => {
      await openIt(ws, 's1', { epoch: 'E', headSeq: 7 });
      await openIt(ws, 's2', { epoch: 'E', headSeq: 9 });
      const done = (window as any).claude.session.unwatch('s2');
      ws.receive({ type: 'session:unwatch:response', id: ws.sentOf('session:unwatch').at(-1).id, payload: { ok: true } });
      await done;
      await (window as any).claude.remote.rehydrate();
      const watched = await openIt(ws, 's1', { __req: { fresh: true } });
      expect(watched.payload.have).toBeUndefined();                     // a Refresh asks for a fresh page
      const unwatched = await openIt(ws, 's2');
      expect(unwatched.payload.have).toBeUndefined();                   // and so does the one it was not watching
    });

    it('hands the computer\'s per-session summary to subscribers, and to one that subscribes after the push', async () => {
      const first: any[] = [];
      (window as any).claude.on.sessionSummary((p: any) => first.push(p));
      ws.receive({ type: 'session:summary', payload: { summaries: { s1: { working: true, awaitingCount: 0, attention: 'ok', hasHistory: true, queuedCount: 0, permissionMode: null, model: null } } } });
      expect(first).toHaveLength(1);
      expect(first[0].summaries.s1.working).toBe(true);
      const late: any[] = [];
      (window as any).claude.on.sessionSummary((p: any) => late.push(p));
      expect(late).toHaveLength(1);                                      // told the latest at once
    });

    it('forgets a destroyed session\'s offsets and backlog', async () => {
      await openIt(ws, 's1');
      output('s1', 'abc', 0);
      ws.receive({ type: 'session:destroyed', payload: { sessionId: 's1', exitCode: 0 } });
      const seen: string[] = [];
      (window as any).claude.on.ptyOutputForSession('s1', (d: string) => seen.push(d));
      expect(seen).toEqual([]);
    });

    it('an old host that sends no epoch leaves the offsets unreported rather than wrong', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await openIt(ws, 's1');
      ws.receive({ type: 'pty:output', payload: { sessionId: 's1', data: 'abc' } });
      const seen: string[] = [];
      (window as any).claude.on.ptyOutputForSession('s1', (d: string) => seen.push(d));
      expect(seen).toEqual(['abc']);
      ws.close();
      vi.advanceTimersByTime(1000);
      const ws2 = FakeWebSocket.instances[1];
      ws2.open();
      ws2.receive({ type: 'auth:ok', deviceId: 'dev-1', platform: 'desktop' });
      await Promise.resolve();
      const req = await openIt(ws2, 's1');
      expect(req.payload.pty).toEqual({});
    });

    it('the line-break search is bounded: a replay with no nearby line break keeps its full tail', async () => {
      await openIt(ws, 's1');
      const replay = 'x'.repeat(300 * 1024) + '\n' + 'y'.repeat(10);
      output('s1', replay, 0);
      const seen: string[] = [];
      (window as any).claude.on.ptyOutputForSession('s1', (d: string) => seen.push(d));
      const total = seen.reduce((n, d) => n + d.length, 0);
      expect(total).toBeGreaterThan(250 * 1024);
      expect(total).toBeLessThanOrEqual(256 * 1024);
    });

    it('a live frame from a NEW buffer (another epoch) resets the terminal before drawing', async () => {
      await openIt(ws, 's1');
      const seen: string[] = [];
      (window as any).claude.on.ptyResetForSession('s1', () => seen.push('<RESET>'));
      (window as any).claude.on.ptyOutputForSession('s1', (d: string) => seen.push(d));
      output('s1', 'old', 0, 'e1');
      output('s1', 'new', 0, 'e2');
      output('s1', '!', 3, 'e2');
      expect(seen).toEqual(['old', '<RESET>', 'new', '!']);
    });

    it('pairing to a different host forgets every terminal position', async () => {
      await openIt(ws, 's1');
      output('s1', 'abc', 0);
      (globalThis as any).location.host = 'other-desktop:9900';
      const p2 = shim.connect('pw', false);
      const ws2 = FakeWebSocket.instances[1];
      ws2.open();
      ws2.receive({ type: 'auth:ok', deviceId: 'dev-1', secret: 's', platform: 'desktop' });
      await p2;
      const req = await openIt(ws2, 's1');
      expect(req.payload.pty).toEqual({});
    });
  });
});

// Remote access batch 2, design §6 (T4), contract R13–R15: the shim alone knows
// where the phone's copy of the conversation stands, and says so —
// reconnecting / restoring / incomplete / complete — and Refresh re-asks the host.
describe('remote-shim — conversation status', () => {
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
    close(code = 1000) { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
    receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
    sentOf(type: string) { return this.sent.map((s) => JSON.parse(s)).filter((m) => m.type === type); }
  }

  describe('remote:conversation-status', () => {
    let shim: typeof import('../src/renderer/remote-shim');
    let phases: string[];

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
      // The page's event bus (a bare node global has none): the shim tells App about a reconnect and a Refresh through it.
      const bus = new EventTarget();
      (globalThis as any).addEventListener = bus.addEventListener.bind(bus);
      (globalThis as any).removeEventListener = bus.removeEventListener.bind(bus);
      (globalThis as any).dispatchEvent = bus.dispatchEvent.bind(bus);
      shim = await import('../src/renderer/remote-shim');
      shim.installShim();
      phases = [];
    });
    afterEach(() => { vi.useRealTimers(); delete (globalThis as any).WebSocket; });

    const claude = () => (window as any).claude;

    /** What App does: subscribe late (after auth:ok), then report how each round of fills went. */
    function mountApp() {
      const off = claude().on.remoteConversationStatus((s: { phase: string }) => phases.push(s.phase));
      claude().on.sessionCreated(() => {});
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
      claude().remote.reportFill({ failed: 0 });
      expect(phases).toEqual(['restoring', 'complete']);

      ws1.close();
      expect(phases[phases.length - 1]).toBe('reconnecting');
      vi.advanceTimersByTime(1000);
      const ws2 = FakeWebSocket.instances[1];
      ws2.open();
      ws2.receive({ type: 'auth:ok', deviceId: 'dev-1', platform: 'desktop' });
      await Promise.resolve();
      expect(phases[phases.length - 1]).toBe('restoring');
      claude().remote.reportFill({ failed: 0 });
      expect(phases).toEqual(['restoring', 'complete', 'reconnecting', 'restoring', 'complete']);
    });

    it('a reconnect tells the page so it can fill every conversation again from where it left off', async () => {
      const ws1 = await firstConnect();
      mountApp();
      const heard: number[] = [];
      window.addEventListener('youcoded:remote-reconnected', () => heard.push(1));
      ws1.close();
      vi.advanceTimersByTime(1000);
      const ws2 = FakeWebSocket.instances[1];
      ws2.open();
      ws2.receive({ type: 'auth:ok', deviceId: 'dev-1', platform: 'desktop' });
      await Promise.resolve();
      expect(heard).toHaveLength(1);
    });

    it('a round where any conversation could not be filled is incomplete', async () => {
      await firstConnect();
      mountApp();
      claude().remote.reportFill({ failed: 1 });
      expect(phases[phases.length - 1]).toBe('incomplete');
    });

    it('no report within 10 s of connecting is incomplete', async () => {
      await firstConnect();
      mountApp();
      vi.advanceTimersByTime(9_999);
      expect(phases).toEqual(['restoring']);
      vi.advanceTimersByTime(1);
      expect(phases).toEqual(['restoring', 'incomplete']);
    });

    it('Refresh re-enters restoring, tells the page to fill everything from a fresh page, and a report completes it (nothing is asked of the host)', async () => {
      const ws = await firstConnect();
      mountApp();
      claude().remote.reportFill({ failed: 1 });
      expect(phases[phases.length - 1]).toBe('incomplete');

      const asked: number[] = [];
      window.addEventListener('youcoded:remote-refresh', () => asked.push(1));
      await expect(claude().remote.rehydrate()).resolves.toEqual({ ok: true });
      expect(asked).toHaveLength(1);
      expect(phases[phases.length - 1]).toBe('restoring');
      expect(ws.sentOf('remote:rehydrate')).toEqual([]);
      claude().remote.reportFill({ failed: 0 });
      expect(phases[phases.length - 1]).toBe('complete');
    });

    it('a report from an older round changes nothing', async () => {
      await firstConnect();
      mountApp();
      claude().remote.rehydrate();
      const before = [...phases];
      claude().remote.reportFill({ round: 1, failed: 0 });
      expect(phases).toEqual(before);
    });

    it('the unsubscribe it returns stops the pushes', async () => {
      await firstConnect();
      const off = mountApp();
      off();
      claude().remote.reportFill({ failed: 0 });
      expect(phases).toEqual(['restoring']);
    });

    it('a Refresh while disconnected sends nothing and leaves the strip saying reconnecting', async () => {
      const ws = await firstConnect();
      mountApp();
      claude().remote.reportFill({ failed: 0 });
      ws.close();
      const before = [...phases];
      await expect(claude().remote.rehydrate()).resolves.toEqual({ ok: false });
      expect(phases).toEqual(before);
    });

    it('a host that refuses this device for good is not shown as reconnecting', async () => {
      const ws = await firstConnect();
      mountApp();
      claude().remote.reportFill({ failed: 0 });
      ws.close(4003);
      expect(phases).not.toContain('reconnecting');
    });

    it('leaving a paired computer forgets the phase instead of showing "reconnecting"', async () => {
      await firstConnect();
      mountApp();
      claude().remote.reportFill({ failed: 0 });
      void shim.disconnectFromHost().catch(() => {});
      for (let i = 0; i < 50 && FakeWebSocket.instances.length < 2; i++) await new Promise((r) => setImmediate(r));
      expect(FakeWebSocket.instances.length).toBe(2);
      expect(phases).not.toContain('reconnecting');
      const late: string[] = [];
      claude().on.remoteConversationStatus((s: { phase: string }) => late.push(s.phase));
      expect(late).toEqual([]);                     // no stale phase replayed to a new subscriber
    });

    it('the host\'s focus is kept from sign-in for App to read', async () => {
      const p = shim.connect('pw', false);
      const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      ws.open();
      ws.receive({ type: 'auth:ok', deviceId: 'dev-1', secret: 's', platform: 'desktop', focus: { sessionId: 's7' } });
      await p;
      expect(claude().remote.focus()).toBe('s7');
    });

    it('the desktop\'s focus reaches session:destroyed listeners', async () => {
      const ws = await firstConnect();
      const got: any[] = [];
      claude().on.sessionDestroyed((...args: any[]) => got.push(args));
      ws.receive({ type: 'session:destroyed', payload: { sessionId: 's1', exitCode: 0, focus: { sessionId: 's2' } } });
      ws.receive({ type: 'session:destroyed', payload: { sessionId: 's3', exitCode: 1 } });
      expect(got).toEqual([['s1', 0, 's2'], ['s3', 1, null]]);
    });
  });

  describe('watching on the Android app\'s own bridge', () => {
    it('never sends session:unwatch to the on-device runtime: it is refused quietly, like session:open', async () => {
      vi.resetModules();
      FakeWebSocket.instances = [];
      (globalThis as any).WebSocket = FakeWebSocket;
      (globalThis as any).window = globalThis;
      (globalThis as any).location = { protocol: 'file:', host: '', search: '?bridgeToken=t&bridgePort=9901' };
      (globalThis as any).localStorage = { _s: {} as Record<string, string>, getItem(k: string) { return this._s[k] ?? null; }, setItem(k: string, v: string) { this._s[k] = v; }, removeItem(k: string) { delete this._s[k]; } };
      const local = await import('../src/renderer/remote-shim');
      local.installShim();
      const p = local.connect('android-local', false);
      const ws = FakeWebSocket.instances[0];
      ws.open();
      ws.receive({ type: 'auth:ok', platform: 'android' });
      await p;
      await expect((window as any).claude.session.unwatch('s1')).rejects.toThrow(/remote-unsupported: session:unwatch/);
      await expect((window as any).claude.session.open({ sessionId: 's1' })).rejects.toThrow(/remote-unsupported: session:open/);
      expect(ws.sentOf('session:unwatch')).toEqual([]);
      expect(ws.sentOf('session:open')).toEqual([]);
    });
  });

  describe('remote:conversation-status on the Android app\'s own bridge', () => {
    it('pushes nothing — that bridge is not filled from a computer, so there is no copy to describe', async () => {
      vi.resetModules();
      FakeWebSocket.instances = [];
      (globalThis as any).WebSocket = FakeWebSocket;
      (globalThis as any).window = globalThis;
      (globalThis as any).location = { protocol: 'file:', host: '', search: '?bridgeToken=t&bridgePort=9901' };
      (globalThis as any).localStorage = { _s: {} as Record<string, string>, getItem(k: string) { return this._s[k] ?? null; }, setItem(k: string, v: string) { this._s[k] = v; }, removeItem(k: string) { delete this._s[k]; } };
      const local = await import('../src/renderer/remote-shim');
      local.installShim();
      const p = local.connect('android-local', false);
      const ws = FakeWebSocket.instances[0];
      ws.open();
      ws.receive({ type: 'auth:ok', platform: 'android' });
      await p;
      const seen: string[] = [];
      (window as any).claude.on.remoteConversationStatus((s: { phase: string }) => seen.push(s.phase));
      (window as any).claude.on.sessionCreated(() => {});
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      vi.advanceTimersByTime(20_000);
      expect(seen).toEqual([]);
      vi.useRealTimers();
    });
  });
});

// Destin, 2026-09-11, phone test of remote access batches 2/3: "the themes also aren't
// matching again? dev is on meadow mist and remote chose golden daybreak". Reloading the
// phone fixed it: a phone read the computer's theme once, at page load, and never heard a
// change after that — the shim's appearance.onSync/broadcast were no-ops and the host sent
// no appearance:sync to remote clients. These pin both directions.
describe('remote-shim — appearance sync', () => {
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

  describe('remote-shim: appearance changes reach and leave a phone that is already open', () => {
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
    afterEach(() => { delete (globalThis as any).WebSocket; });

    async function connected(): Promise<FakeWebSocket> {
      const p = shim.connect('pw', false);
      const ws = FakeWebSocket.instances[0];
      ws.open();
      ws.receive({ type: 'auth:ok', deviceId: 'dev-1', secret: 's', platform: 'desktop' });
      await p;
      return ws;
    }

    it('a theme change pushed by the computer reaches onSync', async () => {
      const ws = await connected();
      const got: any[] = [];
      const off = (window as any).claude.appearance.onSync((prefs: any) => got.push(prefs));
      ws.receive({ type: 'appearance:sync', payload: { theme: 'meadow-mist' } });
      expect(got).toEqual([{ theme: 'meadow-mist' }]);

      off();
      ws.receive({ type: 'appearance:sync', payload: { theme: 'midnight' } });
      expect(got).toHaveLength(1);
    });

    it('a theme change made on the phone is sent to the computer to pass on', async () => {
      const ws = await connected();
      (window as any).claude.appearance.broadcast({ theme: 'golden-sunbreak' });
      expect(ws.sentOf('appearance:broadcast').map((m) => m.payload)).toEqual([{ theme: 'golden-sunbreak' }]);
    });
  });
});
