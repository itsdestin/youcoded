// Pins T3's remote relay (docs/active/specs/2026-09-26-doc-comments-build-
// design.md §1.6, review 2 F6): docComments:list/add/watch/unwatch over the
// WS remote-access surface reach the SAME main-process store desktop windows
// use, and a WS-connected browser that called docComments:watch gets an
// UNPROMPTED docComments:changed push when a comment changes elsewhere —
// remote is explicitly NOT the same gap Android has (design §1.6).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __resetDocCommentsWatcherForTest, initDocCommentsWatcher } from '../src/main/doc-comments/doc-comments-watcher';

// Same three module-scope mocks remote-server.test.ts itself relies on to
// import remote-server.ts at all (WebSocketServer, the HTTP listener, and
// Tailscale detection) — copied rather than shared, per this suite's own
// "a test lives with its feature" convention (test-suite-hygiene.md).
vi.mock('ws', async () => {
  const { EventEmitter: EE } = await import('events');
  class MockWebSocketServer extends EE {
    clients = new Set();
    close = vi.fn((cb?: () => void) => cb?.());
    constructor(_opts?: any) { super(); }
  }
  const MockWebSocket: any = vi.fn();
  MockWebSocket.OPEN = 1;
  return { WebSocketServer: MockWebSocketServer, WebSocket: MockWebSocket };
});

vi.mock('../src/main/remote-config', async () => {
  const actual = await vi.importActual<typeof import('../src/main/remote-config')>('../src/main/remote-config');
  return {
    ...actual,
    RemoteConfig: Object.assign(
      function RemoteConfigStub() {} as unknown as typeof actual.RemoteConfig,
      actual.RemoteConfig,
      { detectTailscale: vi.fn(async () => ({ installed: true, connected: true, ip: '100.64.0.1', hostname: 'test-host', url: 'http://test-host:9900' })) },
    ),
  };
});

vi.mock('http', async () => {
  const { EventEmitter: EE } = await import('events');
  function createServer(_handler?: any) {
    const emitter: any = new EE();
    return Object.assign(emitter, {
      listen: vi.fn((_port: number, hostOrCb?: any, maybeCb?: () => void) => {
        (typeof hostOrCb === 'function' ? hostOrCb : maybeCb)?.();
        return emitter;
      }),
      close: vi.fn((cb?: () => void) => cb?.()),
    });
  }
  return { default: { createServer }, createServer };
});

// F1 fix (post-T3 build review, blocker): remote-server.ts's docComments
// cases now refuse an unrecognized projectRoot via the SAME gate desktop's
// ipc-handlers.ts uses, with a live session's cwd (this.sessionRoots(),
// sourced from sessionManager.listSessions()) counting as "known" — mirrors
// design §1.4's useActiveProject.ts precedent. `cwds` lets each test register
// whichever temp dir it uses as `root` so existing "legitimate path" cases
// keep working under the new gate.
function mockSessionManager(cwds: string[] = []): any {
  return Object.assign(new EventEmitter(), {
    listSessions: vi.fn(() => cwds.map((cwd) => ({ cwd, status: 'active' }))),
  });
}

function mockHookRelay(): any {
  return new EventEmitter();
}

function mockRemoteConfig(): any {
  return { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
}

describe('docComments over remote access', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-remote-'));
  });

  it('list/add work over the WS surface, the same main-process store desktop windows use', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager([root]), mockHookRelay(), mockRemoteConfig());
    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    const client = { id: 'phone-a', ws };
    await server.handleMessage(client, JSON.stringify({
      type: 'docComments:add', id: 'req-1',
      payload: { path: 'docs/plan.md', projectRoot: root, selector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1' } }, text: 'hi', author: 'user' },
    }));
    expect(sent[0].payload).toEqual({ ok: true, id: expect.any(String) });
    await server.handleMessage(client, JSON.stringify({
      type: 'docComments:list', id: 'req-2', payload: { path: 'docs/plan.md', projectRoot: root },
    }));
    expect(sent[1].payload.ok).toBe(true);
    expect(sent[1].payload.comments).toHaveLength(1);
  });

  // F4 (T5 implementation review): the renderer mints the comment id and
  // sends it — the WS surface forwards it through, same as desktop IPC.
  it('forwards a caller-supplied id straight through over the WS surface (F4, T5 review)', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager([root]), mockHookRelay(), mockRemoteConfig());
    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    const client = { id: 'phone-a', ws };
    const callerId = 'c-cafecafe-cafe-4caf-8caf-cafecafecafe';
    await server.handleMessage(client, JSON.stringify({
      type: 'docComments:add', id: 'req-1',
      payload: { path: 'docs/plan.md', projectRoot: root, selector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1' } }, text: 'hi', author: 'user', id: callerId },
    }));
    expect(sent[0].payload).toEqual({ ok: true, id: callerId });
  });

  // T13 (redesigned 2026-09-27, threaded-comments-only, §4): a .xlsx target's
  // mutations are real over the remote WS surface too (T3 built BOTH desktop
  // IPC and this WS surface off the same dispatch module — they must never
  // disagree about which formats are real). q3.xlsx has two sheets, so the
  // write-side selector names `sheet` (§4.2). The fixture's own genuine
  // legacy Notes are never surfaced any more (§4.1) — `list` reads zero until
  // a real thread is added.
  it('list on a .xlsx target reads the file over the WS surface; add writes for real', async () => {
    const fixturesDir = path.join(__dirname, 'fixtures', 'doc-comments');
    await fs.promises.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.promises.copyFile(path.join(fixturesDir, 'q3-sales-by-rep.xlsx'), path.join(root, 'reports', 'q3.xlsx'));
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager([root]), mockHookRelay(), mockRemoteConfig());
    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    const client = { id: 'phone-a', ws };
    await server.handleMessage(client, JSON.stringify({
      type: 'docComments:list', id: 'req-1', payload: { path: 'reports/q3.xlsx', projectRoot: root },
    }));
    expect(sent[0].payload.ok).toBe(true);
    expect(sent[0].payload.comments).toEqual([]);
    await server.handleMessage(client, JSON.stringify({
      type: 'docComments:add', id: 'req-2',
      payload: {
        path: 'reports/q3.xlsx', projectRoot: root,
        selector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1', sheet: 'Q3' } },
        text: 'x', author: 'user',
      },
    }));
    expect(sent[1].payload).toEqual({ ok: true, id: expect.stringMatching(/^xt-/), text: 'x' });
    await server.handleMessage(client, JSON.stringify({
      type: 'docComments:list', id: 'req-3', payload: { path: 'reports/q3.xlsx', projectRoot: root },
    }));
    expect(sent[2].payload.ok).toBe(true);
    expect(sent[2].payload.comments.length).toBeGreaterThan(0);
  });

  // T11: a .docx target's mutations are real over the remote WS surface too
  // (T3 built BOTH desktop IPC and this WS surface off the same dispatch
  // module — they must never disagree about which formats are real).
  it('list on a .docx target reads the file over the WS surface; add writes for real', async () => {
    const fixturesDir = path.join(__dirname, 'fixtures', 'doc-comments');
    await fs.promises.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.promises.copyFile(path.join(fixturesDir, 'launch-brief.docx'), path.join(root, 'docs', 'launch-brief.docx'));
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager([root]), mockHookRelay(), mockRemoteConfig());
    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    const client = { id: 'phone-a', ws };
    await server.handleMessage(client, JSON.stringify({
      type: 'docComments:list', id: 'req-1', payload: { path: 'docs/launch-brief.docx', projectRoot: root },
    }));
    expect(sent[0].payload.ok).toBe(true);
    expect(sent[0].payload.comments.length).toBeGreaterThan(0);
    await server.handleMessage(client, JSON.stringify({
      type: 'docComments:add', id: 'req-2',
      payload: {
        path: 'docs/launch-brief.docx', projectRoot: root,
        selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'Marketing emails go out', prefix: '', suffix: '', occurrence: 0 } },
        text: 'x', author: 'user',
      },
    }));
    expect(sent[1].payload).toEqual({ ok: true, id: expect.stringMatching(/^w-/), text: 'x' });
  });

  it('refuses a ../../etc/passwd-shaped path over the WS surface, same as desktop (F3/F1)', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager([root]), mockHookRelay(), mockRemoteConfig());
    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    await server.handleMessage({ id: 'phone-a', ws }, JSON.stringify({
      type: 'docComments:list', id: 'req-1', payload: { path: '../../../../etc/passwd', projectRoot: root },
    }));
    expect(sent[0].payload).toEqual({ ok: false, error: 'path-outside-project' });
  });

  it('a WS-connected browser that called docComments:watch gets an UNPROMPTED push on a comment change (review 2, F6)', async () => {
    __resetDocCommentsWatcherForTest();
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager([root]), mockHookRelay(), mockRemoteConfig());
    // In production, ipc-handlers.ts's registerDocCommentsHandlers wires this
    // SAME module-level watcher's emit callback (once, at app start) to
    // include `remoteServer?.broadcast` alongside the webContents fan-out —
    // this test drives only the remote-server half of that already-wired
    // pipe, since it does not stand up the full ipc-handlers.ts dependency
    // graph (doc-comments-ipc-handlers.test.ts pins the webContents half).
    // `projectRoot` forwarded too (F3, T5 review) — mirrors ipc-handlers.ts's
    // real production wiring, which this hand-rolled stand-in otherwise drifts from.
    initDocCommentsWatcher((sourcePath, projectRoot) => server.broadcast({ type: 'docComments:changed', payload: { path: sourcePath, projectRoot } }));
    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    const client = { id: 'phone-a', ws };
    server.clients.add(client);

    await server.handleMessage(client, JSON.stringify({
      type: 'docComments:watch', id: 'req-watch', payload: { path: 'docs/live.md', projectRoot: root },
    }));
    expect(sent[0].payload.ok).toBe(true);

    sent.length = 0;
    // A change made through a SEPARATE path (main's own store, standing in
    // for a desktop window's own edit) must still reach this remote browser
    // unprompted — proving the relay, not just the request/response wiring.
    const deadline = Date.now() + 12_500;
    let pushed = false;
    for (let attempt = 0; Date.now() < deadline && !pushed; attempt++) {
      const addWs: any = { readyState: 1, send: () => {} };
      await server.handleMessage({ id: 'desktop-writer', ws: addWs }, JSON.stringify({
        type: 'docComments:add', id: `req-add-${attempt}`,
        payload: { path: 'docs/live.md', projectRoot: root, selector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1' } }, text: `x${attempt}`, author: 'user' },
      }));
      const attemptDeadline = Date.now() + 2500;
      while (Date.now() < attemptDeadline) {
        if (sent.some((s) => s.type === 'docComments:changed')) { pushed = true; break; }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(pushed).toBe(true);
    const evt = sent.find((s) => s.type === 'docComments:changed');
    expect(evt.payload).toEqual({ path: 'docs/live.md', projectRoot: root });
  });

  describe('projectRoot gate over the WS surface (post-T3 build review, F1 — blocker)', () => {
    // RED-BEFORE-GREEN: against the pre-fix commit (58ee463df) every case
    // here resolves ok:true (or a store-level error unrelated to the root)
    // instead of refusing.
    it('refuses "/" as projectRoot the same way desktop IPC does', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      // Deliberately NO session registered for '/' — a forged root must not
      // pass just because SOME session is live.
      const server: any = new RemoteServer(mockSessionManager([root]), mockHookRelay(), mockRemoteConfig());
      const sent: any[] = [];
      const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
      await server.handleMessage({ id: 'phone-a', ws }, JSON.stringify({
        type: 'docComments:add', id: 'req-1',
        payload: { path: 'docs/plan.md', projectRoot: '/', selector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1' } }, text: 'x', author: 'user' },
      }));
      expect(sent[0].payload).toEqual({ ok: false, error: 'unknown-project-root' });
    });

    it('refuses an unregistered temp directory that is not this client’s live session root', async () => {
      const forged = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-remote-forged-'));
      try {
        const { RemoteServer } = await import('../src/main/remote-server');
        // The session manager knows about `root`, not `forged` — a phone
        // naming a directory no live session actually runs in must refuse,
        // exactly design §8's "every root a phone names is checked" rule.
        const server: any = new RemoteServer(mockSessionManager([root]), mockHookRelay(), mockRemoteConfig());
        const sent: any[] = [];
        const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
        await server.handleMessage({ id: 'phone-a', ws }, JSON.stringify({
          type: 'docComments:list', id: 'req-1', payload: { path: 'docs/plan.md', projectRoot: forged },
        }));
        expect(sent[0].payload).toEqual({ ok: false, error: 'unknown-project-root' });
      } finally {
        await fs.promises.rm(forged, { recursive: true, force: true });
      }
    });

    it('refuses watch/unwatch for an unknown projectRoot too', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager([root]), mockHookRelay(), mockRemoteConfig());
      const sent: any[] = [];
      const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
      const client = { id: 'phone-a', ws };
      await server.handleMessage(client, JSON.stringify({
        type: 'docComments:watch', id: 'req-1', payload: { path: 'docs/plan.md', projectRoot: '/' },
      }));
      expect(sent[0].payload).toEqual({ ok: false, error: 'unknown-project-root' });
      await server.handleMessage(client, JSON.stringify({
        type: 'docComments:unwatch', id: 'req-2', payload: { path: 'docs/plan.md', projectRoot: '/' },
      }));
      expect(sent[1].payload).toEqual({ ok: false, error: 'unknown-project-root' });
    });
  });

  describe('fallback (no projectRoot) source-file gate over the WS surface (F1 blocker, Gate 2)', () => {
    it('refuses an untracked absolute .docx path with no projectRoot over remote, same as desktop', async () => {
      const fixturesDir = path.join(__dirname, 'fixtures', 'doc-comments');
      const loose = path.join(root, 'untracked.docx');
      await fs.promises.copyFile(path.join(fixturesDir, 'launch-brief.docx'), loose);
      const { RemoteServer } = await import('../src/main/remote-server');
      // No projectRoot in the payload at all — the fallback path — so the
      // session-cwd gate above never even runs; Gate 2 (authorizeBytesRead)
      // is what must refuse this.
      const server: any = new RemoteServer(mockSessionManager([root]), mockHookRelay(), mockRemoteConfig());
      const sent: any[] = [];
      const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
      await server.handleMessage({ id: 'phone-a', ws }, JSON.stringify({
        type: 'docComments:list', id: 'req-1', payload: { path: loose },
      }));
      expect(sent[0].payload).toEqual({ ok: false, error: 'path-not-tracked' });
    });

    // Live-refresh review (2026-09-27, finding 1 — high): `docComments:watch`
    // called `resolveWatchTarget` (the same function `list` uses to resolve
    // its own target) but skipped Gate 2 entirely — a WS-connected client
    // (already past password auth) could start a live filesystem watch on an
    // arbitrary absolute `.docx`/`.xlsx` path with no `projectRoot`, learning
    // "this file exists" and getting a live change signal for a path `list`
    // on the SAME path would correctly refuse.
    it('refuses to watch an untracked absolute .docx path with no projectRoot over remote', async () => {
      const fixturesDir = path.join(__dirname, 'fixtures', 'doc-comments');
      const loose = path.join(root, 'untracked-watch.docx');
      await fs.promises.copyFile(path.join(fixturesDir, 'launch-brief.docx'), loose);
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager([root]), mockHookRelay(), mockRemoteConfig());
      const sent: any[] = [];
      const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
      await server.handleMessage({ id: 'phone-a', ws }, JSON.stringify({
        type: 'docComments:watch', id: 'req-1', payload: { path: loose },
      }));
      expect(sent[0].payload).toEqual({ ok: false, error: 'path-not-tracked' });
    });
  });
});
