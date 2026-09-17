import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// The Electron surface the gate touches: app-level window events and, when a
// window registry is given, the webContents → BrowserWindow lookup.
const windowsByWc = new Map<number, any>();
vi.mock('electron', () => {
  const app = new EventEmitter();
  return {
    app,
    webContents: { fromId: (id: number) => (windowsByWc.has(id) ? { id, isDestroyed: () => false } : null) },
    BrowserWindow: { fromWebContents: (wc: { id: number }) => windowsByWc.get(wc.id) ?? null },
  };
});

import { app } from 'electron';
import { startStatusPushGate } from '../src/main/status-push-gate';

function fakeWindow(visible = true) {
  return Object.assign(new EventEmitter(), {
    visible, minimized: false,
    isDestroyed: () => false,
    isVisible() { return this.visible; },
    isMinimized() { return this.minimized; },
  });
}

// Simplification audit W2: the 10 s status push is deduplicated, skipped while
// nobody can see a status bar, and made up the moment someone looks again.
describe('startStatusPushGate', () => {
  let payload: Record<string, unknown>;
  let delivered: unknown[];
  let gate: ReturnType<typeof startStatusPushGate> | null;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    payload = { usage: 1 };
    delivered = [];
    gate = null;
    windowsByWc.clear();
  });
  afterEach(() => {
    gate?.stop();
    (app as EventEmitter).removeAllListeners();
    vi.useRealTimers();
  });

  const tick = () => vi.advanceTimersByTimeAsync(10_000);
  const settle = () => vi.advanceTimersByTimeAsync(0);

  function start(extra: Partial<Parameters<typeof startStatusPushGate>[0]> = {}) {
    const mainWindow = fakeWindow();
    gate = startStatusPushGate({
      build: async () => ({ ...payload }),
      deliver: (d) => delivered.push(d),
      mainWindow: mainWindow as any,
      ...extra,
    });
    return { mainWindow, gate };
  }

  it('delivers a changed payload once and never repeats an identical one', async () => {
    start();
    await tick();
    expect(delivered).toHaveLength(1);
    await tick(); await tick();
    expect(delivered).toHaveLength(1);
    payload = { usage: 2 };
    await tick();
    expect(delivered).toHaveLength(2);
  });

  it('re-sends an unchanged payload when the set of windows changed — a new window has never seen it', async () => {
    let ids = [1];
    start({ windowRegistry: { getMainWindowIds: () => ids, getWindowIds: () => ids } });
    windowsByWc.set(1, fakeWindow());
    await tick();
    expect(delivered).toHaveLength(1);
    ids = [1, 2];
    windowsByWc.set(2, fakeWindow());
    await tick();
    expect(delivered).toHaveLength(2);
  });

  it('skips the tick while no main window is visible, then pushes at once on focus', async () => {
    const { mainWindow } = start();
    await tick();
    expect(delivered).toHaveLength(1);
    mainWindow.visible = false;
    payload = { usage: 2 };
    await tick(); await tick();
    expect(delivered).toHaveLength(1);
    mainWindow.visible = true;
    (app as EventEmitter).emit('browser-window-focus');
    await settle();
    expect(delivered).toHaveLength(2);
    (app as EventEmitter).emit('browser-window-focus'); // no missed tick behind it
    await settle();
    expect(delivered).toHaveLength(2);
  });

  it('a minimised window is not an audience; restore pushes what was missed', async () => {
    const { mainWindow } = start();
    mainWindow.minimized = true;
    await tick();
    expect(delivered).toHaveLength(0);
    mainWindow.minimized = false;
    mainWindow.emit('restore');
    await settle();
    expect(delivered).toHaveLength(1);
  });

  it('a window created later is watched for show/restore too', async () => {
    const { mainWindow } = start();
    mainWindow.visible = false;
    const second = fakeWindow(false);
    (app as EventEmitter).emit('browser-window-created', {}, second);
    await tick();
    expect(delivered).toHaveLength(0);
    second.visible = true;
    second.emit('show');
    await settle();
    expect(delivered).toHaveLength(1);
  });

  it('a connected phone is an audience, and a phone connecting gets the missed push', async () => {
    let clients = 0;
    let onStatus: ((s: { clientCount: number }) => void) | null = null;
    const { mainWindow } = start({
      remoteServer: { getClientCount: () => clients, onStatusChange: (cb) => { onStatus = cb; return () => {}; } },
    });
    mainWindow.visible = false;
    await tick();
    expect(delivered).toHaveLength(0);
    clients = 1;
    onStatus!({ clientCount: 1 });
    await settle();
    expect(delivered).toHaveLength(1);
    payload = { usage: 2 };
    await tick(); // window still hidden — the phone keeps the tick alive
    expect(delivered).toHaveLength(2);
  });

  it('with a registry, only main windows count and a hidden one is skipped', async () => {
    start({ windowRegistry: { getMainWindowIds: () => [7], getWindowIds: () => [7, 8] } });
    const main = fakeWindow(false);
    windowsByWc.set(7, main);
    windowsByWc.set(8, fakeWindow(true)); // a buddy window: shown, but not a main window
    await tick();
    expect(delivered).toHaveLength(0);
    main.visible = true;
    await tick();
    expect(delivered).toHaveLength(1);
  });

  it('stop() ends the interval and ignores later window events', async () => {
    const { mainWindow } = start();
    mainWindow.visible = false;
    await tick();
    gate!.stop();
    expect(vi.getTimerCount()).toBe(0);
    mainWindow.visible = true;
    (app as EventEmitter).emit('browser-window-focus');
    await settle();
    expect(delivered).toHaveLength(0);
  });
});
