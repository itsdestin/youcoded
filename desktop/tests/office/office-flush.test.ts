// Saving open Office documents before a window closes or the app quits (design §4): main asks
// the window, waits for its answer or 5 s, and a window's own re-issued close goes through.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  OFFICE_FLUSH_DONE, OFFICE_FLUSH_REQUEST, OFFICE_PROCEED, askToFlush, flushThenQuitOfficeSessions, holdCloseForOfficeSave, officeQuitGate,
} from '../../src/main/office/office-flush';

/** A fake ipcMain and a window whose renderer answers flush requests (or not). */
function setup(opts: { answers?: boolean; failed?: number } = {}) {
  const ipc = new EventEmitter();
  const requests: string[] = [];
  const webContents = {
    id: 7,
    once: vi.fn(),
    isDestroyed: () => false,
    send: vi.fn((channel: string, id: string) => {
      if (channel !== OFFICE_FLUSH_REQUEST) return;
      requests.push(id);
      if (opts.answers !== false) queueMicrotask(() => ipc.emit(OFFICE_FLUSH_DONE, { sender: webContents }, id, { failed: opts.failed ?? 0 }));
    }),
  };
  const win = { webContents, destroyed: false, isDestroyed() { return this.destroyed; }, close: vi.fn() };
  const deps = { hasDocuments: (id: number) => id === 7, ipc: ipc as never, capMs: 5_000 };
  return { ipc, win, webContents, requests, deps };
}

afterEach(() => { vi.useRealTimers(); });

describe('asking a window to save its Office documents', () => {
  it("resolves when the window answers with the request's own id", async () => {
    const { webContents, ipc, requests } = setup();
    await expect(askToFlush(webContents, ipc as never)).resolves.toBe('flushed');
    expect(requests).toHaveLength(1);
    expect(ipc.listenerCount(OFFICE_FLUSH_DONE)).toBe(0);
  });

  it("ignores another request's answer", async () => {
    vi.useFakeTimers();
    const { webContents, ipc } = setup({ answers: false });
    const p = askToFlush(webContents, ipc as never, 5_000);
    ipc.emit(OFFICE_FLUSH_DONE, {}, 'flush-someone-else');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toBe('timeout');
  });

  it('gives up after 5 s when the window never answers', async () => {
    vi.useFakeTimers();
    const { webContents, ipc } = setup({ answers: false });
    const p = askToFlush(webContents, ipc as never, 5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    let done = false; void p.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe('timeout');
  });
});

describe('closing a window with Office documents open', () => {
  it('holds the close, asks the window to save, then closes it — and that second close goes through', async () => {
    const { win, deps, requests } = setup();
    const ev = { preventDefault: vi.fn() };
    expect(holdCloseForOfficeSave(win, ev, deps)).toBe(true);
    expect(ev.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(win.close).toHaveBeenCalledTimes(1));
    expect(requests).toHaveLength(1);
    // The re-issued close: let it through, no second request (no close loop).
    const ev2 = { preventDefault: vi.fn() };
    expect(holdCloseForOfficeSave(win, ev2, deps)).toBe(false);
    expect(ev2.preventDefault).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it('still closes after 5 s when the window never answers', async () => {
    vi.useFakeTimers();
    const { win, deps } = setup({ answers: false });
    expect(holdCloseForOfficeSave(win, { preventDefault() {} }, deps)).toBe(true);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(win.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it('does not hold a window with no Office documents open', () => {
    const { win, deps } = setup();
    const ev = { preventDefault: vi.fn() };
    expect(holdCloseForOfficeSave(win, ev, { ...deps, hasDocuments: () => false })).toBe(false);
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });
});

describe('quitting with Office documents open', () => {
  it('asks every window with documents to save before the sessions are stopped', async () => {
    const { win, deps, requests } = setup();
    const order: string[] = [];
    const quit = vi.fn(async () => { order.push(`quit after ${requests.length} request(s)`); });
    await flushThenQuitOfficeSessions([win], deps, quit);
    expect(order).toEqual(['quit after 1 request(s)']);
  });

  it('stops the sessions after 5 s even when a window never answers', async () => {
    vi.useFakeTimers();
    const { win, deps } = setup({ answers: false });
    const quit = vi.fn(async () => {});
    const p = flushThenQuitOfficeSessions([win], deps, quit);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(quit).toHaveBeenCalledTimes(1);
  });
});

describe('a window whose documents could not all be saved', () => {
  it("ignores an answer from any window but the one asked", async () => {
    vi.useFakeTimers();
    const { webContents, ipc } = setup({ answers: false });
    const p = askToFlush(webContents, ipc as never, 5_000);
    const [id] = webContents.send.mock.calls.map((c) => c[1] as string);
    ipc.emit(OFFICE_FLUSH_DONE, { sender: { id: 99 } }, id, { failed: 0 });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toBe('timeout');
  });

  it('keeps the window open when it answers that a document could not be saved, however long the person takes', async () => {
    vi.useFakeTimers();
    const { win, deps } = setup({ failed: 1 });
    expect(holdCloseForOfficeSave(win, { preventDefault() {} }, deps)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(win.close).not.toHaveBeenCalled();
  });

  it('closes on "Close anyway" from that window — and not from another', async () => {
    const { win, deps, ipc, webContents } = setup({ failed: 1 });
    holdCloseForOfficeSave(win, { preventDefault() {} }, deps);
    await new Promise((r) => setTimeout(r, 0));
    ipc.emit(OFFICE_PROCEED, { sender: { id: 99 } });
    expect(win.close).not.toHaveBeenCalled();
    ipc.emit(OFFICE_PROCEED, { sender: webContents });
    expect(win.close).toHaveBeenCalledTimes(1);
    // The close it re-issued goes straight through.
    expect(holdCloseForOfficeSave(win, { preventDefault() {} }, deps)).toBe(false);
  });

  it('holds a quit the same way, and "Close anyway" quits — the gate then lets it by', async () => {
    const { win, deps, ipc, webContents } = setup({ failed: 2 });
    const quitApp = vi.fn();
    await expect(officeQuitGate([win], { ...deps, quitApp })).resolves.toBe(false);
    expect(quitApp).not.toHaveBeenCalled();
    ipc.emit(OFFICE_PROCEED, { sender: webContents });
    expect(quitApp).toHaveBeenCalledTimes(1);
    await expect(officeQuitGate([win], { ...deps, quitApp })).resolves.toBe(true);
  });

  it('lets a quit go ahead when every document saved', async () => {
    const { win, deps } = setup();
    await expect(officeQuitGate([win], deps)).resolves.toBe(true);
  });

  it('lets a quit go ahead after 5 s when a window never answers (a hung renderer)', async () => {
    vi.useFakeTimers();
    const { win, deps } = setup({ answers: false });
    const p = officeQuitGate([win], deps);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toBe(true);
  });
});

describe("the editor's own unload veto", () => {
  it('is overridden, once, for a close the person chose ("Close anyway")', async () => {
    const { win, deps, ipc, webContents } = setup({ failed: 1 });
    holdCloseForOfficeSave(win, { preventDefault() {} }, deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(webContents.once).not.toHaveBeenCalled();
    ipc.emit(OFFICE_PROCEED, { sender: webContents });
    expect(webContents.once).toHaveBeenCalledWith('will-prevent-unload', expect.any(Function));
    const veto = { preventDefault: vi.fn() };
    (webContents.once.mock.calls[0][1] as (e: typeof veto) => void)(veto);
    expect(veto.preventDefault).toHaveBeenCalled();
  });

  it('is overridden for a close after every document saved', async () => {
    const { win, deps, webContents } = setup();
    holdCloseForOfficeSave(win, { preventDefault() {} }, deps);
    await vi.waitFor(() => expect(win.close).toHaveBeenCalled());
    expect(webContents.once).toHaveBeenCalledWith('will-prevent-unload', expect.any(Function));
  });
});
