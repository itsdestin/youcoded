// Equivalence: every session-scoped push that used to be a `sendForSession` + `remoteServer.broadcast` PAIR still
// reaches exactly the same audiences with exactly the same payload now that it is one `publish` call (one-core R5-1).
//
// WHY behavioural and not a text scan: the test boots the real registerIpcHandlers with a REAL WindowRegistry (an owner,
// a buddy subscriber, an unrelated window, a primary window) and a recording phone server, fires each family's real source
// event, and reads what each window and the phone server were told. The expectations are the OLD pair's behaviour written
// out: owner + subscriber get `(channel, ...args)`, nobody else does, the primary window only when the session has no
// audience, and a phone gets exactly one `{type, payload}`. The first describe holds nothing about the record, so the same
// assertions run unchanged against the r5-pre tree (the run is quoted in the R5-1 report).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const h = vi.hoisted(() => ({ sent: new Map<number, Array<{ channel: string; args: any[] }>>(), watcher: null as any }));

vi.mock('electron', () => {
  const BrowserWindowMock: any = vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } }));
  BrowserWindowMock.getAllWindows = vi.fn(() => []);
  BrowserWindowMock.fromWebContents = vi.fn(() => ({ focus: vi.fn() }));
  return {
    app: { isPackaged: false, getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0-test'), whenReady: vi.fn(() => new Promise(() => {})), on: vi.fn(), quit: vi.fn(), setAppUserModelId: vi.fn(), commandLine: { appendSwitch: vi.fn() }, getGPUInfo: vi.fn(() => new Promise(() => {})) },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    BrowserWindow: BrowserWindowMock,
    // A window's webContents is a recorder keyed by its id: what each window was sent is the observable.
    webContents: { fromId: (id: number) => ({ isDestroyed: () => false, send: (channel: string, ...args: any[]) => { (h.sent.get(id) ?? h.sent.set(id, []).get(id)!).push({ channel, args }); } }) },
    Menu: { setApplicationMenu: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    dialog: { showOpenDialog: vi.fn() },
    clipboard: { readImage: vi.fn(() => ({ isEmpty: () => true })) },
    nativeImage: {},
    shell: { openExternal: vi.fn() },
    powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() },
  };
});

// The transcript watcher is the one source object registerIpcHandlers builds itself; capture it to fire its events.
vi.mock('../src/main/transcript-watcher', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWatcher extends EventEmitter {
    constructor() {
      super();
      h.watcher = this;
      // Every other method the handlers call at wiring time is inert.
      return new Proxy(this, { get: (t: any, k) => (k in t ? t[k] : () => undefined) });
    }
  }
  return { TranscriptWatcher: FakeWatcher };
});

import { registerIpcHandlers } from '../src/main/ipc-handlers';
import { WindowRegistry } from '../src/main/window-registry';
import { createRuntime } from '../src/main/create-runtime';
import { createElectronPlatform } from '../src/main/electron-platform';
import { IPC } from '../src/shared/types';

const PRIMARY = 1, OWNER = 2, BUDDY = 3, OTHER = 4;
const SID = 'sess-1';

interface World { registry: WindowRegistry; phoneMessages: any[]; runtime: any; remote: any; outbox: any; sentTo: (id: number) => Array<{ channel: string; args: any[] }> }

function boot(): World {
  h.sent.clear();
  const registry = new WindowRegistry();
  registry.registerWindow(PRIMARY, 1);
  registry.registerWindow(OWNER, 2);
  registry.registerWindow(BUDDY, 3, 'buddy');
  registry.registerWindow(OTHER, 4);
  registry.assignSession(SID, OWNER);
  registry.subscribe(SID, BUDDY);

  const phoneMessages: any[] = [];
  const remote = {
    getClientCount: vi.fn(() => 0), broadcastStatusData: vi.fn(), onStatusChange: vi.fn(() => () => {}),
    broadcast: vi.fn((m: any) => { phoneMessages.push(m); }),
    setSessionMetaWiring: vi.fn(), setLastTopic: vi.fn(), setHandoffRoute: vi.fn(),
  };
  const sessionManager: any = new EventEmitter();
  Object.assign(sessionManager, {
    createSession: vi.fn(), destroySession: vi.fn(() => true), listSessions: vi.fn(() => []), getSession: vi.fn(() => undefined),
    sendInput: vi.fn(), resizeSession: vi.fn(), hasSession: vi.fn(() => true),
  });
  const mainWindow: any = {
    isDestroyed: () => false,
    webContents: { id: PRIMARY, send: (channel: string, ...args: any[]) => { (h.sent.get(PRIMARY) ?? h.sent.set(PRIMARY, []).get(PRIMARY)!).push({ channel, args }); } },
  };
  const skillProvider: any = { configStore: { getPackages: vi.fn(() => ({})) }, install: vi.fn(), installMany: vi.fn(), ensureBundledPluginsInstalled: vi.fn(), ensureMigrated: vi.fn(), getInstalled: vi.fn(() => []) };
  const runtime = createRuntime({
    userDataDir: '/tmp', appVersion: '0.0.0-test', platform: createElectronPlatform(), chatgptAuth: null, sessionManager,
  });
  const wiring = registerIpcHandlers(
    { handle: vi.fn(), on: vi.fn() } as any, sessionManager, mainWindow, skillProvider,
    undefined as any, undefined, undefined, remote as any, registry as any, undefined as any, runtime, undefined,
  );
  return { registry, phoneMessages, runtime, remote, outbox: wiring.outboxBroadcast, sentTo: (id) => h.sent.get(id) ?? [] };
}

const only = (w: World, channel: string) => (id: number) => w.sentTo(id).filter((s) => s.channel === channel);
const phoneOf = (w: World, type: string) => w.phoneMessages.filter((m) => m.type === type);

/** One family: how to fire its real source event, what the windows get after the channel, what a phone gets. */
interface Family {
  name: string;
  channel: string;
  fire(w: World, payload: any): void;
  payload: any;
  windowArgs?: (payload: any) => any[];
  phonePayload?: (payload: any) => any;
}

const ev = { sessionId: SID, type: 'assistant-text', uuid: 'u1', timestamp: 1, data: { text: 'hi', model: 'm1' } };
const FAMILIES: Family[] = [
  { name: 'transcript event (native)', channel: IPC.TRANSCRIPT_EVENT, payload: ev, fire: (w, p) => w.runtime.nativeHost.emit('transcript-event', p) },
  { name: 'transcript event (Claude Code watcher)', channel: IPC.TRANSCRIPT_EVENT, payload: ev, fire: (_w, p) => h.watcher.emit('transcript-event', p) },
  { name: 'transcript shrink', channel: IPC.TRANSCRIPT_SHRINK, payload: { sessionId: SID, oldSize: 10, newSize: 2 }, fire: (_w, p) => h.watcher.emit('transcript-shrink', p) },
  {
    name: 'hook event (native ask)', channel: IPC.HOOK_EVENT,
    payload: { type: 'PermissionRequest', sessionId: SID, payload: { _requestId: 'native-r1', tool_name: 'Bash' }, timestamp: 1 },
    fire: (w, p) => w.runtime.nativeHost.emit('hook-event', p),
  },
  {
    name: 'specialists event', channel: IPC.SPECIALISTS_EVENT, payload: { kind: 'run', sessionId: SID, run: { childId: 'c1' } },
    fire: (w, p) => w.runtime.nativeHost.emit('specialists-event', p),
  },
  { name: 'session context', channel: IPC.NATIVE_SESSION_CONTEXT, payload: { sessionId: SID, context: { a: 1 } }, fire: (w, p) => w.runtime.nativeHost.emit('session-context', p) },
  {
    name: 'shell event', channel: IPC.NATIVE_SHELL_EVENT, payload: { sessionId: SID, run: { shellId: 's1' } },
    fire: (w, p) => w.runtime.nativeHost.emit('shell-event', p),
  },
  { name: 'permission mode', channel: IPC.NATIVE_PERMISSION_MODE, payload: { sessionId: SID, mode: 'auto-edit' }, fire: (w, p) => w.runtime.nativeHost.emit('permission-mode', p) },
  {
    name: 'model state', channel: IPC.NATIVE_MODEL_STATE, payload: { sessionId: SID, modelId: 'm1', state: 'loaded', sizeBytes: 5, loadedBytes: null },
    fire: (w) => {
      w.runtime.nativeHost.sessionsForModel = vi.fn(() => [SID]);
      w.runtime.engineManager.emit('models-changed', [{ id: 'm1', state: 'loaded', sizeBytes: 5, loadedBytes: undefined }]);
    },
  },
  {
    // Windows get (sessionId, change); phones get {sessionId, ...change}: the one family whose two shapes differ.
    name: 'session meta changed', channel: IPC.SESSION_META_CHANGED, payload: { flag: 'tag:t1', value: true },
    fire: (w, p) => w.outbox.sessionMeta(SID, p),
    windowArgs: (p) => [SID, p], phonePayload: (p) => ({ sessionId: SID, ...p }),
  },
];

describe('publish delivers what each sendForSession + broadcast pair delivered', () => {
  let w: World;
  beforeEach(() => { w = boot(); });

  for (const f of FAMILIES) {
    describe(f.name, () => {
      it('reaches the session\'s owner and subscriber with the same arguments, and nobody else', () => {
        f.fire(w, f.payload);
        const at = only(w, f.channel);
        const expected = [{ channel: f.channel, args: f.windowArgs ? f.windowArgs(f.payload) : [f.payload] }];
        expect(at(OWNER)).toEqual(expected);
        expect(at(BUDDY)).toEqual(expected);
        expect(at(OTHER)).toEqual([]);
        expect(at(PRIMARY)).toEqual([]); // the primary window is the ownerless fallback only
      });

      it('reaches every phone once, as {type, payload} numbered with the record\'s {epoch, seq}', () => {
        f.fire(w, f.payload);
        // WHY the numbers (one-core R5-2): publish numbers the event first, so a phone can say where it got to and be sent what it missed.
        expect(phoneOf(w, f.channel)).toEqual([{ type: f.channel, payload: f.phonePayload ? f.phonePayload(f.payload) : f.payload, epoch: expect.any(String), seq: 1 }]);
      });

      it('falls back to the primary window when nobody owns the session (and phones still hear it)', () => {
        w.registry.releaseSession(SID);
        f.fire(w, f.payload);
        const at = only(w, f.channel);
        expect(at(PRIMARY)).toEqual([{ channel: f.channel, args: f.windowArgs ? f.windowArgs(f.payload) : [f.payload] }]);
        expect(at(OWNER)).toEqual([]);
        expect(phoneOf(w, f.channel)).toHaveLength(1);
      });
    });
  }
});

describe('the record sees what publish delivered', () => {
  it('every family lands in the session\'s ring as one numbered event with the phone\'s payload', () => {
    const w = boot();
    w.runtime.records.begin(SID);
    for (const f of FAMILIES) f.fire(w, f.payload);
    const events = w.runtime.records.events(SID);
    expect(events.map((e: any) => e.type)).toEqual(FAMILIES.map((f) => f.channel));
    expect(events.map((e: any) => e.seq)).toEqual(FAMILIES.map((_f, i) => i + 1));
    expect(events.at(-1).payload).toEqual({ sessionId: SID, flag: 'tag:t1', value: true });
  });
});
