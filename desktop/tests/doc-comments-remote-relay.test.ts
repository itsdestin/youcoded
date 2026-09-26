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

function mockSessionManager(): any {
  return Object.assign(new EventEmitter(), { listSessions: vi.fn(() => []) });
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
    const server: any = new RemoteServer(mockSessionManager(), mockHookRelay(), mockRemoteConfig());
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

  it('list on a .docx target reads the file over the WS surface; add refuses honestly', async () => {
    const fixturesDir = path.join(__dirname, 'fixtures', 'doc-comments');
    await fs.promises.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.promises.copyFile(path.join(fixturesDir, 'launch-brief.docx'), path.join(root, 'docs', 'launch-brief.docx'));
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager(), mockHookRelay(), mockRemoteConfig());
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
      payload: { path: 'docs/launch-brief.docx', projectRoot: root, selector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1' } }, text: 'x', author: 'user' },
    }));
    expect(sent[1].payload).toEqual({ ok: false, error: 'not-yet-supported' });
  });

  it('refuses a ../../etc/passwd-shaped path over the WS surface, same as desktop (F3/F1)', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager(), mockHookRelay(), mockRemoteConfig());
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
    const server: any = new RemoteServer(mockSessionManager(), mockHookRelay(), mockRemoteConfig());
    // In production, ipc-handlers.ts's registerDocCommentsHandlers wires this
    // SAME module-level watcher's emit callback (once, at app start) to
    // include `remoteServer?.broadcast` alongside the webContents fan-out —
    // this test drives only the remote-server half of that already-wired
    // pipe, since it does not stand up the full ipc-handlers.ts dependency
    // graph (doc-comments-ipc-handlers.test.ts pins the webContents half).
    initDocCommentsWatcher((sourcePath) => server.broadcast({ type: 'docComments:changed', payload: { path: sourcePath } }));
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
    expect(evt.payload).toEqual({ path: 'docs/live.md' });
  });
});
