import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Specialists plans, Task 6 — the transport half of design §5.
//
//  1. Desktop IPC and the remote WebSocket call the SAME host methods and hand
//     back the SAME normalized answer, for every one of the seven channels.
//  2. Local Electron hydration: session:replay-live-state (and the whole-
//     transcript replay) pushes one plans:event per journal projection, BEFORE
//     the replay-complete marker, and the invoke resolves only after that.
//  3. The 'plans-event' push reaches the session's own window(s) and every
//     remote client — and the remote server keeps no plan buffer of its own:
//     a reconnecting phone gets plan state inside chat:hydrate only.
// ---------------------------------------------------------------------------

vi.mock('electron', () => {
  const BrowserWindowMock: any = vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } }));
  BrowserWindowMock.getAllWindows = vi.fn(() => []);
  return {
    app: {
      isPackaged: false,
      getPath: vi.fn(() => '/tmp'),
      getVersion: vi.fn(() => '0.0.0-test'),
      whenReady: vi.fn(() => new Promise(() => {})),
      on: vi.fn(),
      quit: vi.fn(),
      setAppUserModelId: vi.fn(),
      commandLine: { appendSwitch: vi.fn() },
      getGPUInfo: vi.fn(() => new Promise(() => {})),
    },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    BrowserWindow: BrowserWindowMock,
    Menu: { setApplicationMenu: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    dialog: { showOpenDialog: vi.fn() },
    clipboard: { readImage: vi.fn(() => ({ isEmpty: () => true })) },
    nativeImage: {},
    shell: { openExternal: vi.fn() },
    powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() },
    screen: { getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })), getAllDisplays: vi.fn(() => []) },
    // Owner/subscriber windows the test registers, by webContents id.
    webContents: { fromId: vi.fn((id: number) => (globalThis as any).__planTestWindows?.get(id) ?? null) },
  };
});

/** The host the ipc-handlers module constructs, reachable from the test. */
const hostRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('../src/main/harness/native-session-host', async () => {
  const { EventEmitter: EE } = await import('node:events');
  class NativeSessionHostStub extends EE {
    constructor() { super(); hostRef.current = this; }

    // What registerIpcHandlers touches while it wires everything up.
    setModelReleasedHandler() { /* no-op */ }

    getHistoryPage() { return null; }

    // Replay / live-state surface, driven per test.
    nativeIds = new Set<string>();

    history: any[] = [];

    isNative(id: string) { return this.nativeIds.has(id); }

    isIdle() { return true; }

    getHistory(id: string) { return this.nativeIds.has(id) ? this.history : null; }

    pendingAskEventsFor() { return []; }

    specialistRunsFor() { return []; }

    shellRunsFor() { return []; }

    planViewsFor = vi.fn(async (_id: string): Promise<any[]> => []);

    // The seven plan actions (Task 4 host API).
    approvePlan = vi.fn();

    commentOnPlan = vi.fn();

    addPlanBudget = vi.fn();

    resumePlan = vi.fn();

    stopPlan = vi.fn();

    getPlanAutoApprove = vi.fn();

    setPlanAutoApprove = vi.fn();
  }
  return { NativeSessionHost: NativeSessionHostStub };
});

import { registerIpcHandlers } from '../src/main/ipc-handlers';
import { RemoteServer } from '../src/main/remote-server';
import { WindowRegistry } from '../src/main/window-registry';
import { IPC } from '../src/shared/types';
import { PLAN_REQUEST_CHANNELS, handlePlanRequest } from '../src/main/harness/plans/plan-requests';
import { chatReducer } from '../src/renderer/state/chat-reducer';

const plan = (seq: number, planId = 'p1') => ({
  planId, toolUseId: `tu-${planId}`, status: 'proposed', seq, steps: [], goal: 'g',
});

/** A remote server stand-in for registerIpcHandlers: any method is a recorded no-op. */
function fakeRemoteServer() {
  const fns = new Map<string, ReturnType<typeof vi.fn>>();
  return new Proxy({} as any, {
    get(_t, prop: string) {
      if (prop === 'then') return undefined;
      if (!fns.has(prop)) fns.set(prop, vi.fn());
      return fns.get(prop);
    },
  });
}

function fakeWindow(id: number) {
  const sent: Array<[string, any]> = [];
  return { id, sent, isDestroyed: () => false, send: (ch: string, ...args: any[]) => sent.push([ch, args[0]]) };
}

function buildDesktop() {
  const ipcMain = { handle: vi.fn(), on: vi.fn() };
  const sessionManager: any = new EventEmitter();
  sessionManager.listSessions = vi.fn(() => []);
  sessionManager.getSession = vi.fn(() => undefined);
  const mainWindow: any = { isDestroyed: () => false, webContents: { send: vi.fn() } };
  const skillProvider: any = {
    configStore: { getPackages: vi.fn(() => ({})) },
    install: vi.fn(), installMany: vi.fn(), ensureBundledPluginsInstalled: vi.fn(), ensureMigrated: vi.fn(),
  };
  const registry = new WindowRegistry();
  const remote = fakeRemoteServer();
  registerIpcHandlers(
    ipcMain as any, sessionManager, mainWindow, skillProvider,
    undefined as any, undefined as any, undefined as any, remote, registry as any,
  );
  const handler = (ch: string) => (ipcMain.handle as any).mock.calls.find((c: any) => c[0] === ch)?.[1];
  const listener = (ch: string) => (ipcMain.on as any).mock.calls.find((c: any) => c[0] === ch)?.[1];
  return { host: hostRef.current, handler, listener, registry, remote, mainWindow };
}

/** What the preload sends for each channel — the same object payload the shim sends. */
const REQUEST_PAYLOADS: Record<string, any> = {
  'plans:approve': { sessionId: 's1', planId: 'p1' },
  'plans:comment': { sessionId: 's1', planId: 'p1', text: 'use the other folder' },
  'plans:add-budget': { sessionId: 's1', planId: 'p1', tokens: 1200 },
  'plans:resume': { sessionId: 's1', planId: 'p1' },
  'plans:stop': { sessionId: 's1', planId: 'p1' },
  'plans:get-auto-approve': {},
  'plans:set-auto-approve': { underTokens: 5000 },
};
const HOST_METHOD: Record<string, string> = {
  'plans:approve': 'approvePlan',
  'plans:comment': 'commentOnPlan',
  'plans:add-budget': 'addPlanBudget',
  'plans:resume': 'resumePlan',
  'plans:stop': 'stopPlan',
  'plans:get-auto-approve': 'getPlanAutoApprove',
  'plans:set-auto-approve': 'setPlanAutoApprove',
};
const EXPECTED_ARGS: Record<string, unknown[]> = {
  'plans:approve': ['s1', 'p1'],
  'plans:comment': ['s1', 'p1', 'use the other folder'],
  'plans:add-budget': ['s1', 'p1', 1200],
  'plans:resume': ['s1', 'p1'],
  'plans:stop': ['s1', 'p1'],
  'plans:get-auto-approve': [],
  'plans:set-auto-approve': [5000],
};

/** Host behaviours every channel must survive the same way on both transports. */
const SCRIPTS: Array<[string, (ch: string) => () => Promise<unknown>]> = [
  ['ok', (ch) => async () => (ch === 'plans:get-auto-approve' ? { ok: true, underTokens: 4000 } : ch === 'plans:set-auto-approve' ? { ok: true } : { ok: true, plan: plan(3) })],
  ['a refusal', () => async () => ({ ok: false, error: 'Budget can only be added to a paused plan.' })],
  ['unsupported', () => async () => ({ ok: false, unsupported: true, error: "Plans aren't available in this session." })],
  ['a throw', () => async () => { throw new Error('EACCES: journal locked'); }],
  ['a malformed answer', () => async () => undefined],
];

async function askRemote(server: any, type: string, payload: unknown) {
  const frames: any[] = [];
  const ws = { readyState: 1, bufferedAmount: 0, send: (raw: string) => frames.push(JSON.parse(raw)) };
  await server.handleMessage({ ws, authenticated: true }, JSON.stringify({ type, id: 'r1', payload }));
  const reply = frames.find((f) => f.id === 'r1');
  expect(reply?.type, `${type} got no response over remote`).toBe(`${type}:response`);
  return reply.payload;
}

beforeEach(() => {
  (globalThis as any).__planTestWindows = new Map();
});

describe('the shared plan request handler', () => {
  it('names exactly the seven channels', () => {
    expect([...PLAN_REQUEST_CHANNELS].sort()).toEqual(Object.keys(HOST_METHOD).sort());
  });

  it('a host that is not there yet answers a plain failure, never unsupported', async () => {
    // WHY not unsupported: the card caches "unsupported" for the life of the
    // window and disables itself; a runtime that is still starting is not that.
    for (const ch of PLAN_REQUEST_CHANNELS) {
      const r: any = await handlePlanRequest(null, ch, REQUEST_PAYLOADS[ch]);
      expect(r.ok).toBe(false);
      expect(r.unsupported).toBeUndefined();
      expect(typeof r.error).toBe('string');
    }
  });

  it('a request without a session or plan id never reaches the host', async () => {
    const host: any = Object.fromEntries(Object.values(HOST_METHOD).map((m) => [m, vi.fn()]));
    for (const bad of [undefined, null, 'x', {}, { sessionId: 's1' }, { sessionId: '', planId: 'p1' }, { sessionId: 's1', planId: 7 }]) {
      const r: any = await handlePlanRequest(host, 'plans:approve', bad);
      expect(r).toMatchObject({ ok: false });
      expect(r.unsupported).toBeUndefined();
    }
    expect(host.approvePlan).not.toHaveBeenCalled();
  });

  it('a thrown host call becomes a general failure that names no guessed cause', async () => {
    const host: any = { approvePlan: vi.fn(async () => { throw new Error('EACCES: journal locked'); }) };
    const r: any = await handlePlanRequest(host, 'plans:approve', REQUEST_PAYLOADS['plans:approve']);
    expect(r).toEqual({ ok: false, error: "Couldn't update the plan. Please try again." });
  });

  it('passes the host’s three answer forms through unchanged', async () => {
    const answers = [{ ok: true, plan: plan(2) }, { ok: false, error: 'no' }, { ok: false, unsupported: true, error: 'not here' }];
    for (const a of answers) {
      const host: any = { stopPlan: vi.fn(async () => a) };
      expect(await handlePlanRequest(host, 'plans:stop', REQUEST_PAYLOADS['plans:stop'])).toEqual(a);
    }
  });
});

describe('desktop IPC and the remote socket answer every plan call identically', () => {
  for (const [label, script] of SCRIPTS) {
    it(`when the host gives ${label}`, async () => {
      const { host, handler } = buildDesktop();
      const server: any = new RemoteServer(Object.assign(new EventEmitter(), { listSessions: () => [] }) as any, new EventEmitter() as any, { enabled: true } as any);
      // The SAME host instance on both transports, as ipc-handlers wires it.
      server.setNativeRuntime({ nativeHost: host });
      for (const ch of PLAN_REQUEST_CHANNELS) {
        const method = host[HOST_METHOD[ch]];
        method.mockReset();
        method.mockImplementation(script(ch));
        const h = handler(ch);
        expect(h, `${ch} has no desktop handler`).toBeTypeOf('function');
        const viaIpc = await h({ sender: { id: 1 } }, REQUEST_PAYLOADS[ch]);
        const viaWs = await askRemote(server, ch, REQUEST_PAYLOADS[ch]);
        // JSON round trip on the IPC side too: that is what reaches the renderer.
        expect(viaWs, ch).toEqual(JSON.parse(JSON.stringify(viaIpc)));
        expect(viaIpc && typeof viaIpc === 'object' && typeof (viaIpc as any).ok === 'boolean', `${ch} answer is not normalized`).toBe(true);
        expect(method).toHaveBeenCalledTimes(2);
        expect(method.mock.calls[0]).toEqual(EXPECTED_ARGS[ch]);
        expect(method.mock.calls[1]).toEqual(EXPECTED_ARGS[ch]);
      }
    });
  }
});

describe('local Electron hydration pushes journal projections', () => {
  it('replay-live-state sends one plans:event per projection before the replay marker, and resolves only after', async () => {
    const { host, handler } = buildDesktop();
    host.nativeIds.add('s1');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    host.planViewsFor.mockImplementation(async (id: string) => { await gate; return id === 's1' ? [plan(4, 'p1'), plan(1, 'p2')] : []; });
    const sender = fakeWindow(1);
    let settled = false;
    const done = Promise.resolve(handler(IPC.SESSION_REPLAY_LIVE_STATE)({ sender }, { sessionId: 's1' })).then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    // The renderer awaits this invoke before it goes on: it must not resolve
    // while the journal read is still out.
    expect(settled).toBe(false);
    release();
    await done;
    const channels = sender.sent.map(([ch]) => ch);
    const plans = sender.sent.filter(([ch]) => ch === IPC.PLANS_EVENT).map(([, p]) => p);
    expect(plans).toEqual([{ sessionId: 's1', plan: plan(4, 'p1') }, { sessionId: 's1', plan: plan(1, 'p2') }]);
    const marker = sender.sent.findIndex(([ch, p]) => ch === IPC.TRANSCRIPT_EVENT && p?.type === 'replay-complete');
    expect(marker).toBeGreaterThan(-1);
    expect(channels.lastIndexOf(IPC.PLANS_EVENT)).toBeLessThan(marker);
  });

  it('a Claude Code session reads no plan journal', async () => {
    const { host, handler } = buildDesktop();
    const sender = fakeWindow(1);
    await handler(IPC.SESSION_REPLAY_LIVE_STATE)({ sender }, { sessionId: 'cc-1' });
    expect(host.planViewsFor).not.toHaveBeenCalled();
    expect(sender.sent.some(([ch]) => ch === IPC.PLANS_EVENT)).toBe(false);
    expect(sender.sent.some(([ch, p]) => ch === IPC.TRANSCRIPT_EVENT && p?.type === 'replay-complete')).toBe(true);
  });

  it('the whole-transcript replay sends history, then the projections, then the marker', async () => {
    const { host, listener } = buildDesktop();
    host.nativeIds.add('s1');
    host.history = [{ type: 'user-message', sessionId: 's1', uuid: 'u1', timestamp: 1, data: { text: 'hi' } }];
    host.planViewsFor.mockResolvedValue([plan(2)]);
    const sender = fakeWindow(1);
    listener(IPC.TRANSCRIPT_REPLAY)({ sender }, { sessionId: 's1' });
    await vi.waitFor(() => expect(sender.sent.some(([, p]) => p?.type === 'replay-complete')).toBe(true));
    const order = sender.sent.map(([ch, p]) => (ch === IPC.PLANS_EVENT ? 'plan' : p?.type));
    expect(order).toEqual(['user-message', 'plan', 'replay-complete']);
  });

  it('a failed journal read still sends the marker, so the page is not left hanging', async () => {
    const { host, handler } = buildDesktop();
    host.nativeIds.add('s1');
    host.planViewsFor.mockRejectedValue(new Error('disk gone'));
    const sender = fakeWindow(1);
    await handler(IPC.SESSION_REPLAY_LIVE_STATE)({ sender }, { sessionId: 's1' });
    expect(sender.sent.some(([ch, p]) => ch === IPC.TRANSCRIPT_EVENT && p?.type === 'replay-complete')).toBe(true);
  });
});

describe('the plans-event push', () => {
  it('reaches the session’s owner and subscribers, not other windows, and every remote client', () => {
    const { host, registry, remote, mainWindow } = buildDesktop();
    const owner = fakeWindow(11);
    const buddy = fakeWindow(12);
    const other = fakeWindow(13);
    for (const w of [owner, buddy, other]) (globalThis as any).__planTestWindows.set(w.id, w);
    registry.registerWindow(11, 1);
    registry.registerWindow(12, 2, 'buddy');
    registry.registerWindow(13, 3);
    registry.assignSession('s1', 11);
    registry.assignSession('s2', 13);
    registry.subscribe('s1', 12);
    const event = { sessionId: 's1', plan: plan(5) };
    host.emit('plans-event', event);
    expect(owner.sent).toEqual([[IPC.PLANS_EVENT, event]]);
    expect(buddy.sent).toEqual([[IPC.PLANS_EVENT, event]]);
    expect(other.sent).toEqual([]);
    expect(mainWindow.webContents.send).not.toHaveBeenCalledWith(IPC.PLANS_EVENT, event);
    expect(remote.broadcast).toHaveBeenCalledWith({ type: 'plans:event', payload: event });
  });

  it('is never buffered for a reconnecting phone: plan state travels in chat:hydrate only', async () => {
    const snapshot = {
      sessions: [['s1', { toolCalls: [['tu-p1', { toolUseId: 'tu-p1', toolName: 'propose_plan', status: 'complete', plan: plan(7) }]] }]],
    } as any;
    const server: any = new RemoteServer(
      Object.assign(new EventEmitter(), { listSessions: () => [] }) as any,
      new EventEmitter() as any,
      { enabled: true } as any,
      undefined,
      { requestSnapshot: async () => snapshot },
    );
    // A delta that happened before this phone connected went to nobody; the
    // server has nothing to remember it with.
    server.broadcast({ type: 'plans:event', payload: { sessionId: 's1', plan: plan(6) } });
    expect(Object.keys(server).filter((k) => /plan/i.test(k))).toEqual([]);
    const frames: any[] = [];
    const ws = { readyState: 1, bufferedAmount: 0, send: (raw: string) => frames.push(JSON.parse(raw)) };
    const client = { id: 't', ws, deviceId: 'd', ip: '', connectedAt: 0, phase: 'restoring', queue: [] as any[] };
    server.clients.add(client);
    // A delta that lands mid-restore is queued and delivered after the hydrate.
    const restoring = server.restoreClient(client, { reconnect: false, replayBuffers: true });
    server.broadcast({ type: 'plans:event', payload: { sessionId: 's1', plan: plan(8) } });
    await restoring;
    const types = frames.map((f) => f.type);
    const hydrate = frames.find((f) => f.type === 'chat:hydrate');
    expect(hydrate.payload.sessions[0][1].toolCalls[0][1].plan).toEqual(plan(7));
    const planFrames = frames.filter((f) => f.type === 'plans:event');
    expect(planFrames.map((f) => f.payload.plan.seq)).toEqual([8]);
    expect(types.indexOf('plans:event')).toBeGreaterThan(types.indexOf('chat:hydrate'));
  });
});

// Review fix 1: a phone that loads a session's FIRST page itself (over
// transcript:page) has no live-state re-send — the shim's replayLiveState is a
// no-op — so without this a finished plan's card kept its proposal-time record
// and live buttons forever.
describe('a remote first page brings its plan records along', () => {
  function pagingServer(planViews: any[]) {
    const host = {
      getHistoryPage: vi.fn((_id: string, before: number | null) => ({
        events: [{ type: 'user-message', sessionId: 's1', uuid: `u-${before}`, timestamp: 1, data: { text: 'hi' } }],
        hasMore: before === null, nextIndex: 5,
      })),
      planViewsFor: vi.fn(async () => planViews),
    };
    const server: any = new RemoteServer(Object.assign(new EventEmitter(), { listSessions: () => [] }) as any, new EventEmitter() as any, { enabled: true } as any);
    server.setNativeRuntime({ nativeHost: host });
    const client = (name: string) => {
      const frames: any[] = [];
      return { frames, c: { id: name, ws: { readyState: 1, bufferedAmount: 0, send: (raw: string) => frames.push(JSON.parse(raw)) }, deviceId: name, phase: 'live' } };
    };
    return { server, host, client };
  }

  it('sends the page first, then every journal record, to the asking client only', async () => {
    const { server, host, client } = pagingServer([plan(9, 'p1'), plan(2, 'p2')]);
    const asker = client('asker');
    const bystander = client('bystander');
    server.clients.add(asker.c);
    server.clients.add(bystander.c);
    await server.handleMessage(asker.c, JSON.stringify({ type: 'transcript:page', id: 'pg', payload: { sessionId: 's1', beforeCursor: null } }));
    await vi.waitFor(() => expect(asker.frames.filter((f) => f.type === 'plans:event')).toHaveLength(2));
    expect(asker.frames.map((f) => f.type)).toEqual(['transcript:page:response', 'plans:event', 'plans:event']);
    expect(asker.frames.slice(1).map((f) => f.payload)).toEqual([
      { sessionId: 's1', plan: plan(9, 'p1') },
      { sessionId: 's1', plan: plan(2, 'p2') },
    ]);
    expect(host.planViewsFor).toHaveBeenCalledWith('s1');
    expect(bystander.frames).toEqual([]);
  });

  it('an older page sends no records — the renderer keeps them from the first page', async () => {
    const { server, host, client } = pagingServer([plan(9)]);
    const asker = client('asker');
    await server.handleMessage(asker.c, JSON.stringify({ type: 'transcript:page', id: 'pg', payload: { sessionId: 's1', beforeCursor: { path: 'native:s1', offset: 5 } } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(asker.frames.map((f) => f.type)).toEqual(['transcript:page:response']);
    expect(host.planViewsFor).not.toHaveBeenCalled();
  });

  it('a record the phone already holds changes nothing', () => {
    const S = 'sess';
    const record = { ...plan(4), toolUseId: 'call-plan', title: 't', ceilingTokens: 1, ceilingUsd: null, model: { label: 'm' } } as any;
    const base = [
      { type: 'SESSION_INIT', sessionId: S },
      { type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: 'u', toolUseId: 'call-plan', toolName: 'propose_plan', toolInput: {} },
      { type: 'PLAN_CHANGED', sessionId: S, plan: record },
    ].reduce(chatReducer as any, new Map()) as any;
    const again: any = chatReducer(base, { type: 'PLAN_CHANGED', sessionId: S, plan: JSON.parse(JSON.stringify(record)) } as any);
    expect(again.get(S).toolCalls.get('call-plan').plan).toEqual(record);
    expect([...again.get(S).toolCalls.keys()]).toEqual([...base.get(S).toolCalls.keys()]);
    expect(again.get(S).pendingPlanRecords).toBeUndefined();
    // …and an older copy never rewinds it.
    const older = chatReducer(base, { type: 'PLAN_CHANGED', sessionId: S, plan: { ...record, seq: 3, status: 'proposed' } } as any);
    expect(older).toBe(base);
  });
});
