// Saving open Office documents before a window closes or the app quits (design §4): main asks
// the window, waits for its answer or 5 s, holds the close or quit when a document could not be
// saved (one prompt, counting every window), and never overrides a window's own unload veto.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  OFFICE_DISMISS, OFFICE_FLUSH_DONE, OFFICE_FLUSH_REQUEST, OFFICE_OTHER_UNSAVED, OFFICE_PROCEED, OFFICE_UNSAVED_PROMPT,
  askToFlush, flushThenQuitOfficeSessions, holdCloseForOfficeSave, officeQuitGate, refuseCloseForOtherUnsaved, refuseQuitForOtherUnsaved, watchOtherUnsaved,
} from '../../src/main/office/office-flush';
import { gatedQuit, onWillQuit, quitAfterTeardown, requestRestart, resetRestartForTests } from '../../src/main/app-restart';

/** A fake ipcMain, shared by every window of one test. */
const newIpc = () => new EventEmitter();

/** A window whose renderer answers flush requests (or not) with `failed` unsaved documents. */
function aWindow(ipc: EventEmitter, id: number, opts: { answers?: boolean; failed?: number; firstPath?: string } = {}) {
  const requests: Array<{ id: string; reason: string }> = [];
  const pushes: unknown[] = [];
  const webContents = {
    id,
    once: vi.fn(),
    isDestroyed: () => false,
    send: vi.fn((channel: string, reqId: string, reason: string) => {
      if (channel === OFFICE_UNSAVED_PROMPT) { pushes.push(reqId); return; }
      if (channel !== OFFICE_FLUSH_REQUEST) return;
      requests.push({ id: reqId, reason });
      const failed = reason === 'final' ? 0 : opts.failed ?? 0;
      if (opts.answers !== false) queueMicrotask(() => ipc.emit(OFFICE_FLUSH_DONE, { sender: { id } }, reqId, { failed, firstPath: opts.firstPath }));
    }),
  };
  const win = { webContents, destroyed: false, isDestroyed() { return this.destroyed; }, close: vi.fn() };
  return { win, webContents, requests, pushes };
}
const depsFor = (ipc: EventEmitter, ids: number[]) => ({ hasDocuments: (id: number) => ids.includes(id), ipc: ipc as never, capMs: 5_000 });

afterEach(() => { vi.useRealTimers(); });

describe('asking a window to save its Office documents', () => {
  it("resolves when the window answers with the request's own id", async () => {
    const ipc = newIpc();
    const { webContents, requests } = aWindow(ipc, 7);
    await expect(askToFlush(webContents, ipc as never)).resolves.toEqual({ how: 'flushed' });
    expect(requests).toHaveLength(1);
    expect(ipc.listenerCount(OFFICE_FLUSH_DONE)).toBe(0);
  });

  it("ignores another request's answer, and an answer from any window but the one asked", async () => {
    vi.useFakeTimers();
    const ipc = newIpc();
    const { webContents } = aWindow(ipc, 7, { answers: false });
    const p = askToFlush(webContents, ipc as never, 5_000);
    const [[, reqId]] = webContents.send.mock.calls as unknown as [string, string][];
    ipc.emit(OFFICE_FLUSH_DONE, { sender: { id: 7 } }, 'flush-someone-else', { failed: 0 });
    ipc.emit(OFFICE_FLUSH_DONE, { sender: { id: 99 } }, reqId, { failed: 0 });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toEqual({ how: 'timeout' });
  });

  it('gives up after 5 s when the window never answers', async () => {
    vi.useFakeTimers();
    const ipc = newIpc();
    const { webContents } = aWindow(ipc, 7, { answers: false });
    const p = askToFlush(webContents, ipc as never, 5_000);
    let done = false; void p.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({ how: 'timeout' });
  });
});

describe('closing a window with Office documents open', () => {
  it('holds the close, asks the window to save, then closes it — and that second close goes through', async () => {
    const ipc = newIpc();
    const { win, requests } = aWindow(ipc, 7);
    const ev = { preventDefault: vi.fn() };
    expect(holdCloseForOfficeSave(win, ev, depsFor(ipc, [7]))).toBe(true);
    expect(ev.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(win.close).toHaveBeenCalledTimes(1));
    expect(requests).toEqual([{ id: expect.any(String), reason: 'close' }]);
    const ev2 = { preventDefault: vi.fn() };
    expect(holdCloseForOfficeSave(win, ev2, depsFor(ipc, [7]))).toBe(false);
    expect(ev2.preventDefault).not.toHaveBeenCalled();
  });

  it('still closes after 5 s when the window never answers (a hung renderer)', async () => {
    vi.useFakeTimers();
    const ipc = newIpc();
    const { win } = aWindow(ipc, 7, { answers: false });
    expect(holdCloseForOfficeSave(win, { preventDefault() {} }, depsFor(ipc, [7]))).toBe(true);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(win.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it('does not hold a window with no Office documents open', () => {
    const ipc = newIpc();
    const { win } = aWindow(ipc, 7);
    const ev = { preventDefault: vi.fn() };
    expect(holdCloseForOfficeSave(win, ev, depsFor(ipc, []))).toBe(false);
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it('keeps the window open when a document could not be saved, and asks the person there', async () => {
    vi.useFakeTimers();
    const ipc = newIpc();
    const { win, pushes } = aWindow(ipc, 7, { failed: 1, firstPath: '/a.docx' });
    holdCloseForOfficeSave(win, { preventDefault() {} }, depsFor(ipc, [7]));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(win.close).not.toHaveBeenCalled();
    expect(pushes).toEqual([{ count: 1, firstPath: '/a.docx' }]);
  });

  it('closes on "Close anyway" from that window — and not from another', async () => {
    const ipc = newIpc();
    const { win } = aWindow(ipc, 7, { failed: 1 });
    holdCloseForOfficeSave(win, { preventDefault() {} }, depsFor(ipc, [7]));
    await new Promise((r) => setTimeout(r, 0));
    ipc.emit(OFFICE_PROCEED, { sender: { id: 99 } });
    expect(win.close).not.toHaveBeenCalled();
    ipc.emit(OFFICE_PROCEED, { sender: { id: 7 } });
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(holdCloseForOfficeSave(win, { preventDefault() {} }, depsFor(ipc, [7]))).toBe(false);
  });

  it('tells the close gate about the failure and, on Close anyway, the proceed', async () => {
    const ipc = newIpc();
    const { win } = aWindow(ipc, 7, { failed: 1 });
    const cb = { onFailed: vi.fn(), onProceed: vi.fn() };
    holdCloseForOfficeSave(win, { preventDefault() {} }, depsFor(ipc, [7]), cb);
    await vi.waitFor(() => expect(cb.onFailed).toHaveBeenCalledTimes(1));
    expect(cb.onProceed).not.toHaveBeenCalled();
    ipc.emit(OFFICE_PROCEED, { sender: { id: 7 } });
    expect(cb.onProceed).toHaveBeenCalledTimes(1);
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it("never overrides the window's own unload veto (an unsaved text-file edit keeps it open)", async () => {
    const ipc = newIpc();
    const { win, webContents } = aWindow(ipc, 7, { failed: 1 });
    holdCloseForOfficeSave(win, { preventDefault() {} }, depsFor(ipc, [7]));
    await new Promise((r) => setTimeout(r, 0));
    ipc.emit(OFFICE_PROCEED, { sender: { id: 7 } });
    const saved = aWindow(ipc, 8);
    holdCloseForOfficeSave(saved.win, { preventDefault() {} }, depsFor(ipc, [8]));
    await vi.waitFor(() => expect(saved.win.close).toHaveBeenCalled());
    expect(webContents.once).not.toHaveBeenCalled();
    expect(saved.webContents.once).not.toHaveBeenCalled();
  });
});

describe('quitting with Office documents open', () => {
  it('goes ahead when every document saved', async () => {
    const ipc = newIpc();
    const { win, requests } = aWindow(ipc, 7);
    await expect(officeQuitGate([win], depsFor(ipc, [7]))).resolves.toBe(true);
    expect(requests[0].reason).toBe('quit');
  });

  it('goes ahead after 5 s when a window never answers (a hung renderer)', async () => {
    vi.useFakeTimers();
    const ipc = newIpc();
    const { win } = aWindow(ipc, 7, { answers: false });
    const p = officeQuitGate([win], depsFor(ipc, [7]));
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toBe(true);
  });

  it('holds the quit with ONE prompt counting every window, and "Close anyway" there quits for all', async () => {
    const ipc = newIpc();
    const a = aWindow(ipc, 7, { failed: 2, firstPath: '/a.docx' });
    const b = aWindow(ipc, 8, { failed: 1, firstPath: '/b.docx' });
    const quitApp = vi.fn();
    await expect(officeQuitGate([a.win, b.win], { ...depsFor(ipc, [7, 8]), quitApp })).resolves.toBe(false);
    expect(a.pushes).toEqual([{ count: 3, firstPath: '/a.docx' }]);
    expect(b.pushes).toEqual([]);
    ipc.emit(OFFICE_PROCEED, { sender: { id: 7 } });
    expect(quitApp).toHaveBeenCalledTimes(1);
    // The quit it re-issued passes the gate without asking again.
    const before = a.requests.length;
    await expect(officeQuitGate([a.win, b.win], { ...depsFor(ipc, [7, 8]), quitApp })).resolves.toBe(true);
    expect(a.requests.length).toBe(before);
  });

  it('"Close anyway" runs the caller\'s own proceed (a restart relaunches, then quits)', async () => {
    const ipc = newIpc();
    const a = aWindow(ipc, 7, { failed: 1, firstPath: '/a.docx' });
    const quitApp = vi.fn();
    const onProceed = vi.fn();
    await expect(officeQuitGate([a.win], { ...depsFor(ipc, [7]), quitApp }, onProceed)).resolves.toBe(false);
    ipc.emit(OFFICE_PROCEED, { sender: { id: 7 } });
    expect(onProceed).toHaveBeenCalledTimes(1);
    expect(quitApp).not.toHaveBeenCalled();
    await officeQuitGate([a.win], { ...depsFor(ipc, [7]), quitApp }); // the gate it skipped once
  });

  it("quit's final save never prompts: every window is told the person already chose", async () => {
    const ipc = newIpc();
    const a = aWindow(ipc, 7, { failed: 2 });
    const quit = vi.fn(async () => {});
    await flushThenQuitOfficeSessions([a.win], depsFor(ipc, [7]), quit);
    expect(a.requests.map((r) => r.reason)).toEqual(['final']);
    expect(a.pushes).toEqual([]);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('stops the sessions after 5 s even when a window never answers', async () => {
    vi.useFakeTimers();
    const ipc = newIpc();
    const { win } = aWindow(ipc, 7, { answers: false });
    const quit = vi.fn(async () => {});
    const p = flushThenQuitOfficeSessions([win], depsFor(ipc, [7]), quit);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(quit).toHaveBeenCalledTimes(1);
  });
});


// A text file with unsaved edits would veto its window's unload after teardown; the quit gate
// refuses the quit before anything is torn down instead, in that window.
describe('quitting while a text file has unsaved edits', () => {
  function editing(id: number) {
    const ipc = newIpc();
    watchOtherUnsaved(ipc as never);
    const w = aWindow(ipc, id);
    const sender = Object.assign(new EventEmitter(), { id });
    const report = (unsaved: boolean) => ipc.emit(OFFICE_OTHER_UNSAVED, { sender }, unsaved);
    const focus = vi.fn();
    return { ipc, ...w, win: Object.assign(w.win, { focus }), focus, report, sender };
  }

  it('refuses the quit with no Office save and no teardown, and says so in that window', async () => {
    const t = editing(21);
    t.report(true);
    await expect(officeQuitGate([t.win], depsFor(t.ipc, [21]))).resolves.toBe(false);
    expect(t.requests).toHaveLength(0); // not even the Office save pass
    expect(t.pushes).toEqual([{ count: 0, firstPath: '', other: true, mode: 'quit', afterTeardown: false, restartDropped: false }]);
    expect(t.focus).toHaveBeenCalled();
    t.report(false); // saved: the next quit goes ahead
    await expect(officeQuitGate([t.win], depsFor(t.ipc, [21]))).resolves.toBe(true);
    t.sender.emit('destroyed');
  });

  it('a restart is refused the same way, and never relaunches later', async () => {
    resetRestartForTests();
    const t = editing(22);
    t.report(true);
    requestRestart(() => {});
    const d = {
      gate: (onProceed: () => void) => officeQuitGate([t.win], depsFor(t.ipc, [22]), onProceed),
      shutdown: vi.fn(async () => {}), relaunch: vi.fn(), quit: vi.fn(), openWindows: () => 1, exit: vi.fn(), setTimer: vi.fn(),
    };
    await gatedQuit(d);
    expect(d.shutdown).not.toHaveBeenCalled();
    const relaunch = vi.fn();
    onWillQuit(relaunch);
    expect(relaunch).not.toHaveBeenCalled();
    t.sender.emit('destroyed');
  });

  it('a file edited during teardown: the quit that follows is refused in that window, not forced', async () => {
    resetRestartForTests();
    const t = editing(24);
    requestRestart(() => {});
    const d = {
      gate: (onProceed: () => void) => officeQuitGate([t.win], depsFor(t.ipc, [24]), onProceed),
      shutdown: vi.fn(async () => { t.report(true); }), // typed into a text file while teardown ran
      relaunch: vi.fn(), quit: vi.fn(), openWindows: () => 1, exit: vi.fn(), setTimer: vi.fn(), clearTimer: vi.fn(),
      refuseForUnsaved: (o: { afterTeardown: boolean; restartDropped: boolean }) => refuseQuitForOtherUnsaved([t.win], () => false, { ...o, ipc: t.ipc as never }),
    };
    await gatedQuit(d);
    expect(d.shutdown).toHaveBeenCalled();
    expect(quitAfterTeardown(d)).toBe(false); // the quit gatedQuit re-issued
    expect(d.exit).not.toHaveBeenCalled();
    expect(t.pushes).toEqual([{ count: 0, firstPath: '', other: true, mode: 'quit', afterTeardown: true, restartDropped: true }]);
    // "Discard and quit" goes on: main quits again (the prompt's proceed).
    const quits = vi.fn();
    const refused = refuseQuitForOtherUnsaved([t.win], () => false, { ipc: t.ipc as never, act: quits });
    expect(refused).toBe(true);
    t.ipc.emit(OFFICE_PROCEED, { sender: { id: 24 } });
    expect(quits).toHaveBeenCalledTimes(1);
    const relaunch = vi.fn();
    onWillQuit(relaunch); // the restart was dropped
    expect(relaunch).not.toHaveBeenCalled();
    t.sender.emit('destroyed');
  });

  it("the last window's close is refused while it has unsaved edits; Discard closes it; another window's is not", () => {
    const t = editing(27);
    t.report(true);
    const other = aWindow(t.ipc, 28);
    const floater = aWindow(t.ipc, 29);
    const isFloater = (w: unknown) => w === floater.win;
    expect(refuseCloseForOtherUnsaved(t.win, isFloater, { ipc: t.ipc as never, windows: [t.win, other.win, floater.win] })).toBe(false);
    expect(refuseCloseForOtherUnsaved(t.win, isFloater, { ipc: t.ipc as never, windows: [t.win, floater.win] })).toBe(true);
    expect(t.pushes).toEqual([{ count: 0, firstPath: '', other: true, mode: 'close', afterTeardown: false, restartDropped: false }]);
    t.ipc.emit(OFFICE_PROCEED, { sender: { id: 27 } }); // Discard and close
    expect(t.win.close).toHaveBeenCalledTimes(1);
    t.sender.emit('destroyed');
  });

  it('a refusal on the close Close anyway re-issued uses that pass up: the next X saves Office again', async () => {
    const t = editing(32);
    const failing = aWindow(t.ipc, 32, { failed: 1 }); // this window's Office save fails…
    const win = Object.assign(failing.win, { focus: vi.fn() });
    const deps = depsFor(t.ipc, [32]);
    holdCloseForOfficeSave(win, { preventDefault() {} }, deps);
    await vi.waitFor(() => expect(failing.pushes).toHaveLength(1));
    t.ipc.emit(OFFICE_PROCEED, { sender: { id: 32 } }); // …Close anyway: main re-issues the close
    expect(win.close).toHaveBeenCalledTimes(1);
    t.report(true); // a text file is unsaved in the last window
    expect(refuseCloseForOtherUnsaved(win, () => false, { ipc: t.ipc as never, windows: [win], hung: () => false })).toBe(true);
    const ev = { preventDefault: vi.fn() };
    expect(holdCloseForOfficeSave(win, ev, deps)).toBe(true); // the next X: Office asked again
    expect(ev.preventDefault).toHaveBeenCalled();
    t.sender.emit('destroyed');
  });

  it('a dismissed refusal is forgotten: a later proceed does not quit', () => {
    const t = editing(31);
    t.report(true);
    const act = vi.fn();
    refuseQuitForOtherUnsaved([t.win], () => false, { ipc: t.ipc as never, act });
    t.ipc.emit(OFFICE_DISMISS, { sender: { id: 31 } });
    t.ipc.emit(OFFICE_PROCEED, { sender: { id: 31 } });
    expect(act).not.toHaveBeenCalled();
    t.sender.emit('destroyed');
  });

  it("a hung last window is not asked about its edits (the hang question must be reachable)", () => {
    const t = editing(30);
    t.report(true);
    expect(refuseCloseForOtherUnsaved(t.win, () => false, { ipc: t.ipc as never, windows: [t.win], hung: () => true })).toBe(false);
    expect(t.pushes).toEqual([]);
    expect(refuseCloseForOtherUnsaved(t.win, () => false, { ipc: t.ipc as never, windows: [t.win], hung: () => false })).toBe(true);
    t.sender.emit('destroyed');
  });

  it('ignores a hung window, and forgets one whose page crashed', async () => {
    const hung = editing(25);
    hung.report(true);
    await expect(officeQuitGate([hung.win], { ...depsFor(hung.ipc, [25]), hung: () => true })).resolves.toBe(true);
    hung.sender.emit('destroyed');
    const crashed = editing(26);
    crashed.report(true);
    crashed.sender.emit('render-process-gone');
    await expect(officeQuitGate([crashed.win], depsFor(crashed.ipc, [26]))).resolves.toBe(true);
    crashed.sender.emit('destroyed');
  });

  it('forgets a window once its page reloads or it is gone', async () => {
    const t = editing(23);
    t.report(true);
    t.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    await expect(officeQuitGate([t.win], depsFor(t.ipc, [23]))).resolves.toBe(true);
    t.sender.emit('destroyed');
  });
});
