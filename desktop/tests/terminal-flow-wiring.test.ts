// Terminal flow control — the main-process WIRING (ipc-handlers.ts + terminal-flow.ts), end to end through the
// real registerIpcHandlers with a real WindowRegistry. Pins the review findings of 2026-10-04:
//  * a session with no desktop terminal that can answer (phone-driven, window closed/reloading, orphaned) is
//    never braked, and what waits for a terminal to mount is capped;
//  * only desktop windows that mounted a terminal for the session count, a second window mounting cannot zero
//    the owner's books, and the ack rule follows the ROUTING rule when a session has no owner;
//  * a window going away or ownership moving releases the brake at once and the session goes back to buffering.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const wcs = vi.hoisted(() => new Map<number, any>());

vi.mock('electron', () => {
  const BrowserWindowMock: any = vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } }));
  BrowserWindowMock.getAllWindows = vi.fn(() => []);
  BrowserWindowMock.fromWebContents = vi.fn(() => ({ focus: vi.fn() }));
  return {
    app: { isPackaged: false, getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0-test'), whenReady: vi.fn(() => new Promise(() => {})), on: vi.fn(), quit: vi.fn(), setAppUserModelId: vi.fn(), commandLine: { appendSwitch: vi.fn() }, getGPUInfo: vi.fn(() => new Promise(() => {})) },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    BrowserWindow: BrowserWindowMock,
    Menu: { setApplicationMenu: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    dialog: { showOpenDialog: vi.fn() },
    clipboard: { readImage: vi.fn(() => ({ isEmpty: () => true })) },
    nativeImage: {},
    shell: { openExternal: vi.fn() },
    powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() },
    webContents: { fromId: vi.fn((id: number) => wcs.get(id)) },
  };
});

vi.mock('../src/main/harness/native-session-host', () => {
  class NativeSessionHostStub {
    constructor(..._args: any[]) { void _args; /* ctor deps unused by this test */ }

    async resume(_id: string, _cwd: string, _binding?: any) { return true; }

    async create(_opts: any) { /* no-op */ }

    getHarnessId(_id: string) { return undefined; }

    getBinding(_id: string) { return undefined; }

    modelForSession(_id: string) { return undefined; }

    async destroy(_id: string) { /* no-op */ }

    // Remaining surface registerIpcHandlers touches at registration time (or
    // could touch from a sibling handler) — inert stubs, none of them run on
    // the code path this test exercises.
    setModelReleasedHandler(_fn: any) { /* no-op */ }

    async destroyAll() { /* no-op */ }

    async clear(_id: string) { /* no-op */ }

    async compact(_id: string) { /* no-op */ }

    async quiesce(_id: string) { /* no-op */ }

    async interrupt(_id: string) { /* no-op */ }

    async send(_id: string, _text: string) { /* no-op */ }

    async invokeSkill() { /* no-op */ }

    getHistory(_id: string) { return []; }

    getPermissionMode(_id: string) { return 'normal'; }

    setPermissionMode() { /* no-op */ }

    respondPermission() { /* no-op */ }

    removeQueued() { /* no-op */ }

    setBinding() { /* no-op */ }

    sessionsForModel(_modelId: string) { return [] as string[]; }

    isNativeSessionId(_id: string) { return true; }

    list() { return [] as any[]; }

    on() { return this; }

    off() { return this; }

    removeAllListeners() { return this; }
  }
  return { NativeSessionHost: NativeSessionHostStub };
});


import { registerIpcHandlers } from '../src/main/ipc-handlers';
import { WindowRegistry } from '../src/main/window-registry';
import { IPC } from '../src/shared/types';

function makeWc(id: number) {
  const wc: any = new EventEmitter();
  wc.id = id; wc.sent = [] as Array<{ channel: string; data: string }>;
  wc.isDestroyed = () => !!wc.dead;
  wc.send = (channel: string, data: string) => { wc.sent.push({ channel, data }); };
  wcs.set(id, wc);
  return wc;
}

const SID = 's1';
function world() {
  wcs.clear();
  const w1 = makeWc(1), w2 = makeWc(2), w3 = makeWc(3);
  const handlers = new Map<string, (...a: any[]) => void>();
  const ipcMain: any = { handle: vi.fn(), on: vi.fn((ch: string, fn: any) => { handlers.set(ch, fn); }) };
  const sm: any = new EventEmitter();
  sm.createSession = vi.fn(); sm.destroySession = vi.fn(); sm.listSessions = vi.fn(() => []); sm.getSession = vi.fn();
  sm.sendInput = vi.fn(); sm.resizeSession = vi.fn();
  sm.ackOutput = vi.fn(); sm.resetOutputCredit = vi.fn();
  const registry = new WindowRegistry();
  for (const id of [1, 2, 3]) registry.registerWindow(id, Date.now(), 'main');
  const mainWindow: any = { isDestroyed: () => false, webContents: w1 };
  registerIpcHandlers(ipcMain, sm, mainWindow, { configStore: { getPackages: vi.fn(() => ({})) }, install: vi.fn(), installMany: vi.fn(), ensureBundledPluginsInstalled: vi.fn(), ensureMigrated: vi.fn() } as any,
    undefined as any, undefined, undefined, undefined, registry as any);
  const ready = (from: any) => handlers.get(IPC.TERMINAL_READY)!({ sender: from }, SID);
  const ack = (from: any, n: number) => handlers.get(IPC.TERMINAL_ACK)!({ sender: from }, SID, n);
  const out = (data: string) => sm.emit('pty-output', SID, data);
  /** Total credit passed back to the PTY worker so far. */
  const released = () => sm.ackOutput.mock.calls.reduce((n: number, c: any[]) => n + c[1], 0);
  return { w1, w2, w3, registry, sm, ready, ack, out, released };
}

describe('terminal flow wiring: nothing can brake a session no desktop terminal will answer', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('a session with no mounted terminal is released at once (phone-driven, tray, orphaned)', () => {
    const t = world();
    t.registry.assignSession(SID, 2);
    t.out('x'.repeat(1000)); t.out('y'.repeat(500));
    expect(t.released()).toBe(1500);                       // nothing waits for an ack that cannot come
    expect(t.w2.sent).toEqual([]);                         // and nothing was sent to a window with no terminal
  });

  it('what waits for a terminal to mount is capped to the newest ~4 M characters, and arrives in order', () => {
    const t = world();
    t.registry.assignSession(SID, 2);
    for (let i = 0; i < 6; i++) t.out(String(i).repeat(1024 * 1024));    // 6 M in 1 M chunks
    t.ready(t.w2);
    const got = t.w2.sent.map((s: any) => s.data);
    const chars = got.reduce((n: number, d: string) => n + d.length, 0);
    expect(chars).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(got[got.length - 1][0]).toBe('5');             // the newest text is what is kept
    expect(got[0][0] >= '2').toBe(true);                   // the oldest was dropped
  });

  it('a mounted terminal brakes the program until it confirms, then releases exactly what it confirmed', () => {
    const t = world();
    t.registry.assignSession(SID, 2); t.ready(t.w2);
    t.out('x'.repeat(1000));
    expect(t.w2.sent.length).toBe(1);
    expect(t.released()).toBe(0);
    t.ack(t.w2, 400);
    expect(t.released()).toBe(400);
    t.ack(t.w2, 600);
    expect(t.released()).toBe(1000);
  });

  it('an acknowledgement from a window that is not a terminal for the session is ignored', () => {
    const t = world();
    t.registry.assignSession(SID, 2); t.ready(t.w2);
    t.out('x'.repeat(1000));
    t.ack(t.w3, 1000);                                     // a stranger cannot release the brake
    expect(t.released()).toBe(0);
  });

  it("a second window mounting a terminal mid-flood cannot zero the owner's books", () => {
    const t = world();
    t.registry.assignSession(SID, 2); t.registry.subscribe(SID, 3);
    t.ready(t.w2);
    t.out('x'.repeat(1000));
    t.ready(t.w3);                                         // a buddy/subscriber terminal mounts now
    expect(t.released()).toBe(0);                          // the owner still owes everything
    expect(t.sm.resetOutputCredit).not.toHaveBeenCalled();
    t.ack(t.w2, 1000);
    expect(t.released()).toBe(1000);                       // the subscriber joined later and owes nothing of that
    t.out('y'.repeat(500));                                // from now on BOTH draw the stream: the slower one paces it
    t.ack(t.w2, 500);
    expect(t.released()).toBe(1000);
    t.ack(t.w3, 500);
    expect(t.released()).toBe(1500);
  });

  it('a second window that stops answering cannot hold the owner hostage (dropped after 5 s of silence)', () => {
    vi.useFakeTimers();
    try {
      const t = world();
      t.registry.assignSession(SID, 2); t.registry.subscribe(SID, 3);
      t.ready(t.w2); t.ready(t.w3);
      t.out('x'.repeat(1000));
      t.ack(t.w2, 1000);
      expect(t.released()).toBe(0);                        // waiting for the subscriber too
      vi.advanceTimersByTime(5100);
      t.out('y'.repeat(10)); t.ack(t.w2, 10);              // the owner keeps going; the quiet subscriber no longer counts
      expect(t.released()).toBe(1010);
    } finally { vi.useRealTimers(); }
  });

  it('with no owner, the window the output is routed to drives the brake (ack rule = routing rule)', () => {
    const t = world();
    t.registry.subscribe(SID, 3);                          // subscriber only: output is routed to window 3
    t.ready(t.w3);
    t.out('x'.repeat(1000));
    expect(t.w3.sent.length).toBe(1);
    expect(t.released()).toBe(0);
    t.ack(t.w3, 1000);
    expect(t.released()).toBe(1000);
  });

  it('the owner closing while the program is braked lets it go at once, and the session goes back to buffering', () => {
    const t = world();
    t.registry.assignSession(SID, 2); t.ready(t.w2);
    t.out('x'.repeat(1000));
    expect(t.released()).toBe(0);
    t.w2.dead = true; t.registry.unregisterWindow(2); t.w2.emit('destroyed');
    expect(t.released()).toBe(1000);
    t.out('z'.repeat(10));
    expect(t.w2.sent.length).toBe(1);                      // nothing more is sent into the dead window
    expect(t.released()).toBe(1010);
  });

  it('a window reload (Ctrl+R) mid-flood releases the brake, buffers until the new page is ready, then re-arms', () => {
    const t = world();
    t.registry.assignSession(SID, 2); t.ready(t.w2);
    t.out('x'.repeat(1000));
    t.w2.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });   // an iframe loading: no effect
    expect(t.released()).toBe(0);
    t.w2.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(t.released()).toBe(1000);
    t.out('after'); expect(t.w2.sent.length).toBe(1);       // held, not sent into the loading page
    t.ready(t.w2);                                          // new page mounts its terminal
    expect(t.w2.sent.map((s: any) => s.data)).toContain('after');
    t.out('y'.repeat(300));
    expect(t.released()).toBe(1000 + 5);                    // 'after' was released while unmounted; the new 300 are owed
    t.ack(t.w2, 300 + 5);
    expect(t.released()).toBe(1000 + 5 + 300);
  });

  it('ownership moving to another window releases what the old owner owed (tear-off / re-dock mid-flood)', () => {
    const t = world();
    t.registry.assignSession(SID, 2); t.ready(t.w2);
    t.out('x'.repeat(1000));
    expect(t.released()).toBe(0);
    t.registry.assignSession(SID, 3);                      // the session moves; window 3 has not mounted yet
    expect(t.released()).toBe(1000);
    t.out('y'.repeat(50));                                 // buffered for the new owner, not braked
    expect(t.released()).toBe(1050);
    t.ready(t.w3);
    expect(t.w3.sent.map((s: any) => s.data)).toEqual(['y'.repeat(50)]);
  });
});
